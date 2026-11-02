import type { Sql } from "postgres";

import { productionCanaryConfig, assertProductionCanaryIdentity } from "./interview-production-canary";
import { productionInterviewDatabase } from "./interview-production-db";
import { verifyLiveCanaryApplicant } from "./interview-production-notion";
import { hasRequiredInterviewTeam, readInterviewTeams, teamForSlot } from "./interview-teams";
import { deliverQueuedProductionMessage } from "./interview-production-mail";
import { handleProductionRescheduleJob } from "./interview-production-reschedule-worker";
import {
  createOrReadProductionInterviewEvent, syncProductionInterviewNotion,
  sendProductionInterviewConfirmation, ProductionProviderError,
  cancelProductionInterviewEvent, clearProductionInterviewNotion,
} from "./interview-production-providers";

import { productionRealEnabled, productionRealConfig, assertProductionBookingIdentity } from "./interview-production-launch";

// Production-real mode is a separate explicit release. Canary-only routes
// retain their original canary guards and cannot be widened by this adapter.
const productionServiceConfig = () => productionRealEnabled()
  ? productionRealConfig() : productionCanaryConfig();
const requireProductionIdentity = (...args: Parameters<typeof assertProductionCanaryIdentity>) =>
  productionRealEnabled()
    ? assertProductionBookingIdentity(args[0],args[1],args[2])
    : assertProductionCanaryIdentity(...args);


export type Job = {
  id: string; operation_key: string; provider: string; action: string;
  object_id: string; attempts: number;
};
type Reservation = {
  id: string; campus: "BU" | "BC"; notion_page_id: string;
  interviewer_id: string; starts_at: Date; ends_at: Date; status: string;
  calendar_id: string | null; calendar_event_id: string | null;
  meet_url: string | null; email: string; interviewer_email: string;
  calendar_operation_key?: string | null;
};
export type JobResult = { state: "done" | "retry" | "reconcile_required" | "failed"; externalId?: string; code?: string };
export type WorkerServices = {
  db?: Sql;
  createEvent?: typeof createOrReadProductionInterviewEvent;
  syncNotion?: typeof syncProductionInterviewNotion;
  sendGmail?: typeof sendProductionInterviewConfirmation;
  verifyApplicant?: typeof verifyLiveCanaryApplicant;
  cancelEvent?: typeof cancelProductionInterviewEvent;
  clearNotion?: typeof clearProductionInterviewNotion;
};
export function isCanaryJob(job: Job): boolean {
  return (job.provider==="google_calendar" && job.action==="create_event" &&
    job.operation_key==="interview-calendar:create:"+job.object_id) ||
    (job.provider==="notion" && job.action==="sync_interview" &&
    job.operation_key==="interview-notion:confirmed:"+job.object_id) ||
    (job.provider==="gmail" && job.action==="send_message" &&
    job.operation_key==="interview-mail:confirmation:"+job.object_id) ||
    (job.provider==="google_calendar" && job.action==="cancel_event" && job.operation_key==="interview-calendar:cancel:"+job.object_id) ||
    (job.provider==="notion" && job.action==="cancel_interview" && job.operation_key==="interview-notion:canceled:"+job.object_id) ||
    (job.provider==="gmail" && job.action==="send_message" && job.operation_key==="interview-mail:cancellation:"+job.object_id) ||
    (job.provider==="gmail" && job.action==="send_message" &&
      /^interview-reminder:[0-9a-f-]{36}:\d{10,16}$/i.test(job.operation_key) &&
      job.operation_key.startsWith("interview-reminder:"+job.object_id+":")) ||
    (job.provider==="google_calendar" && job.action==="reschedule_create" && job.operation_key==="interview-reschedule:create:"+job.object_id) ||
    (job.provider==="gmail" && job.action==="send_message" && job.operation_key==="interview-mail:reschedule:"+job.object_id);
}
function outcome(error: unknown): JobResult {
  if(error instanceof ProductionProviderError)return {state:error.disposition,code:error.code};
  return {state:"reconcile_required",code:"production_provider_outcome_unknown"};
}
async function readReservation(db: Sql, id: string): Promise<Reservation> {
  const rows=await db<Reservation[]>`
    SELECT r.id,r.campus,r.notion_page_id,r.interviewer_id,r.starts_at,r.ends_at,
      r.status,r.calendar_id,r.calendar_event_id,r.calendar_operation_key,r.meet_url,c.email,
      i.workspace_email AS interviewer_email
    FROM interview.reservation r
      JOIN interview.invitation inv ON inv.id=r.invitation_id
      JOIN interview.applicant_contact c ON c.invitation_id=inv.id
      JOIN interview.interviewer i ON i.id=r.interviewer_id
    WHERE r.id=${id} AND inv.revoked_at IS NULL AND inv.email_verified_at IS NOT NULL
      AND (c.opted_out_at IS NULL OR r.status IN ('cancel_pending','canceled'))
      AND r.status IN ('calendar_pending','confirmed','cancel_pending','canceled')
  `;
  if(rows.length!==1)throw new ProductionProviderError("production_worker_reservation_missing","failed");
  const res=rows[0];
  requireProductionIdentity(res.campus,res.email,res.notion_page_id);
  return res;
}
async function runCalendar(job: Job, db: Sql, create: typeof createOrReadProductionInterviewEvent, verifyApplicant: typeof verifyLiveCanaryApplicant): Promise<JobResult> {
  const res=await readReservation(db,job.object_id);
  if(res.status==="confirmed" && res.calendar_event_id && res.meet_url)
    return {state:"done",externalId:res.calendar_event_id};
  if(res.status!=="calendar_pending")return {state:"reconcile_required",code:"production_calendar_state_conflict"};
  const team=teamForSlot(await readInterviewTeams(db),res.interviewer_id,res.starts_at.toISOString(),res.campus);
  if(!team || team.approvedBy!=="president@campus2care.org" || !hasRequiredInterviewTeam(res.campus,team.participants) ||
    team.participants.some(p=>!p.available))
    return {state:"reconcile_required",code:"production_calendar_team_changed"};
  // A student may withdraw after creating the hold but before Calendar writes.
  await verifyApplicant({campus:res.campus,pageId:res.notion_page_id,email:res.email});
  const event=await create({
    operationKey:job.operation_key,reservationId:res.id,campus:res.campus,
    pageId:res.notion_page_id,applicantEmail:res.email,
    participants:team.participants.map(p=>({email:p.email,role:p.role})),
    startsAt:res.starts_at.toISOString(),endsAt:res.ends_at.toISOString(),
  });
  if(event.status!=="confirmed")return {state:"reconcile_required",code:"production_calendar_event_canceled"};
  // Persist the remote ID before waiting for asynchronously created Meet details.
  const saved=await db<{id:string}[]>`UPDATE interview.reservation
    SET calendar_id='interviews@campus2care.org',calendar_event_id=${event.id},
      calendar_operation_key=${job.operation_key},updated_at=now()
    WHERE id=${res.id} AND status='calendar_pending'
      AND (calendar_event_id IS NULL OR calendar_event_id=${event.id})
    RETURNING id`;
  if(saved.length!==1)return {state:"reconcile_required",code:"production_calendar_reservation_changed"};
  if(!event.meetUrl)return {state:"retry",code:"production_calendar_meet_pending"};
  await db.begin(async tx=>{
    const updated=await tx<{id:string}[]>`UPDATE interview.reservation
      SET meet_url=${event.meetUrl},updated_at=now()
      WHERE id=${res.id} AND status='calendar_pending' AND calendar_event_id=${event.id}
      RETURNING id`;
    if(updated.length!==1)throw Error("production_calendar_reservation_changed");
    await tx`INSERT INTO interview.integration_outbox(operation_key,provider,action,object_id)
      VALUES(${"interview-notion:confirmed:"+res.id},'notion','sync_interview',${res.id})
      ON CONFLICT(operation_key) DO NOTHING`;
  });
  return {state:"done",externalId:event.id};
}
async function runNotion(job: Job, db: Sql, sync: typeof syncProductionInterviewNotion): Promise<JobResult> {
  const res=await readReservation(db,job.object_id);
  if(!res.meet_url || !res.calendar_event_id || !["calendar_pending","confirmed"].includes(res.status))
    return {state:"retry",code:"production_notion_calendar_not_ready"};
  await sync({
    campus:res.campus,pageId:res.notion_page_id,applicantEmail:res.email,
    reservationId:res.id,startsAt:res.starts_at.toISOString(),
    interviewerEmail:res.interviewer_email,meetUrl:res.meet_url,
  });
  await db.begin(async tx=>{
    const changed=await tx<{id:string}[]>`UPDATE interview.reservation
      SET status='confirmed',updated_at=now()
      WHERE id=${res.id} AND status IN ('calendar_pending','confirmed') RETURNING id`;
    if(changed.length!==1)throw Error("production_notion_reservation_changed");
    const key="interview-mail:confirmation:"+res.id;
    await tx`INSERT INTO interview.message
      (operation_key,recipient_ref,kind,campus,object_id,payload)
      VALUES(${key},${res.email},'confirmation',${res.campus},${res.id},
        ${tx.json({campus:res.campus,startsAt:res.starts_at.toISOString(),meetUrl:res.meet_url})})
      ON CONFLICT(operation_key) DO NOTHING`;
    await tx`INSERT INTO interview.integration_outbox(operation_key,provider,action,object_id)
      VALUES(${key},'gmail','send_message',${res.id})
      ON CONFLICT(operation_key) DO NOTHING`;
  });
  return {state:"done",externalId:res.id};
}
async function runGmail(job: Job, db: Sql, send: typeof sendProductionInterviewConfirmation): Promise<JobResult> {
  const res=await readReservation(db,job.object_id);
  const kind=job.operation_key.startsWith("interview-reminder:"+res.id+":")
    ? "appointment_reminder" : job.operation_key==="interview-mail:cancellation:"+res.id ? "cancellation" : "confirmation";
  if((kind!=="cancellation" && res.status!=="confirmed") ||
      (kind==="cancellation" && res.status!=="canceled") ||
      (kind!=="cancellation" && !res.meet_url) ||
      (kind==="appointment_reminder" && (res.starts_at.getTime()<=Date.now() ||
        job.operation_key!=="interview-reminder:"+res.id+":"+res.starts_at.getTime())))
    return {state:"retry",code:"production_gmail_not_ready"};
  return deliverQueuedProductionMessage(db,res.id,{
    operationKey:job.operation_key,campus:res.campus,pageId:res.notion_page_id,
    email:res.email,reservationId:res.id,startsAt:res.starts_at.toISOString(),
    meetUrl:res.meet_url??"",kind,
  },send);
}
async function runCancellation(job: Job, db: Sql, deps: WorkerServices): Promise<JobResult> {
  const res=await readReservation(db,job.object_id);
  if (!["cancel_pending","canceled"].includes(res.status)) return {state:"reconcile_required",code:"production_cancel_state_conflict"};
  if (job.provider==="google_calendar") {
    await (deps.cancelEvent??cancelProductionInterviewEvent)({campus:res.campus,pageId:res.notion_page_id,
      applicantEmail:res.email,operationKey:res.calendar_operation_key??"interview-calendar:create:"+res.id});
    await db.begin(async tx=>{
      const changed=await tx<{id:string}[]>`UPDATE interview.reservation SET status='canceled',updated_at=now(),revision=revision+1
        WHERE id=${res.id} AND status IN ('cancel_pending','canceled') RETURNING id`;
      if(changed.length!==1)throw Error("production_cancel_reservation_changed");
      await tx`INSERT INTO interview.integration_outbox(operation_key,provider,action,object_id)
        VALUES(${"interview-notion:canceled:"+res.id},'notion','cancel_interview',${res.id}) ON CONFLICT(operation_key) DO NOTHING`;
    });
  } else {
    if(res.status!=="canceled")return {state:"retry",code:"production_cancel_calendar_pending"};
    await (deps.clearNotion??clearProductionInterviewNotion)({campus:res.campus,pageId:res.notion_page_id,
      applicantEmail:res.email,reservationId:res.id});
    const key="interview-mail:cancellation:"+res.id;
    await db.begin(async tx=>{
      await tx`INSERT INTO interview.message(operation_key,recipient_ref,kind,campus,object_id,payload)
        VALUES(${key},${res.email},'cancellation',${res.campus},${res.id},'{}'::jsonb) ON CONFLICT(operation_key) DO NOTHING`;
      await tx`INSERT INTO interview.integration_outbox(operation_key,provider,action,object_id)
        VALUES(${key},'gmail','send_message',${res.id}) ON CONFLICT(operation_key) DO NOTHING`;
    });
  }
  return {state:"done",externalId:res.id};
}
export async function handleProductionCanaryJob(job: Job, deps: WorkerServices = {}): Promise<JobResult> {
  productionServiceConfig();
  if(!isCanaryJob(job))return {state:"failed",code:"production_worker_unsupported_action"};
  const db=deps.db??productionInterviewDatabase();
  try {
    if(job.action==="reschedule_create" || job.operation_key.startsWith("interview-mail:reschedule:"))
      return await handleProductionRescheduleJob(job,db,deps);
    if(job.action==="cancel_event" || job.action==="cancel_interview")return await runCancellation(job,db,deps);
    if(job.provider==="google_calendar")return await runCalendar(job,db,deps.createEvent??createOrReadProductionInterviewEvent,deps.verifyApplicant??verifyLiveCanaryApplicant);
    if(job.provider==="notion")return await runNotion(job,db,deps.syncNotion??syncProductionInterviewNotion);
    return await runGmail(job,db,deps.sendGmail??sendProductionInterviewConfirmation);
  } catch(e){return outcome(e);}
}
/** Lease jobs atomically. Expired leases are quarantined rather than replayed. */
export async function processProductionCanaryOutbox(
  limit=3,deps: WorkerServices = {},
): Promise<{claimed:number;done:number;reconciliation:number;retry:number}> {
  const config=productionServiceConfig();
  const liveMode=productionRealEnabled();
  if(!Number.isInteger(limit)||limit<1||limit>5)throw Error("invalid_production_worker_limit");
  const canaryEmails="emails" in config ? [...config.emails].join(",") : "";
  const canaryPages="pages" in config ? [...config.pages].join(",") : "";
  const db=deps.db??productionInterviewDatabase();
  await db`UPDATE interview.integration_outbox j SET state='reconcile_required',
    last_error_code='expired_production_lease',lease_until=NULL,updated_at=now()
    WHERE j.state='processing' AND j.lease_until<now()
      AND (j.operation_key LIKE 'interview-calendar:create:%' OR
        j.operation_key LIKE 'interview-notion:confirmed:%' OR
        j.operation_key LIKE 'interview-mail:confirmation:%' OR
        j.operation_key LIKE 'interview-calendar:cancel:%' OR j.operation_key LIKE 'interview-notion:canceled:%' OR
        j.operation_key LIKE 'interview-mail:cancellation:%' OR j.operation_key LIKE 'interview-reschedule:create:%' OR
        j.operation_key LIKE 'interview-mail:reschedule:%' OR
         j.operation_key LIKE 'interview-reminder:%')
      AND EXISTS (
        SELECT 1 FROM interview.reservation r
          LEFT JOIN interview.reschedule_request x ON x.reservation_id=r.id AND x.id=j.object_id
          JOIN interview.invitation i ON i.id=r.invitation_id
          JOIN interview.applicant_contact c ON c.invitation_id=i.id
        WHERE (r.id=j.object_id OR x.id=j.object_id) AND (${liveMode} OR lower(c.email)=ANY(string_to_array(${canaryEmails},',')))
          AND (${liveMode} OR replace(lower(r.notion_page_id),'-','')=ANY(string_to_array(${canaryPages},',')))
      )`;
  let claimed=0,done=0,reconciliation=0,retry=0;
  for(let i=0;i<limit;i++){
    const rows=await db<Job[]>`WITH candidate AS (
      SELECT j.id FROM interview.integration_outbox j
        LEFT JOIN interview.reschedule_request x ON x.id=j.object_id
        JOIN interview.reservation r ON r.id=COALESCE(x.reservation_id,j.object_id)
        JOIN interview.invitation inv ON inv.id=r.invitation_id
        JOIN interview.applicant_contact c ON c.invitation_id=inv.id
      WHERE j.state IN ('queued','retry') AND j.next_attempt_at<=now()
        AND (${liveMode} OR lower(c.email)=ANY(string_to_array(${canaryEmails},',')))
        AND (${liveMode} OR replace(lower(r.notion_page_id),'-','')=ANY(string_to_array(${canaryPages},',')))
        AND ((provider='google_calendar' AND action='create_event' AND operation_key LIKE 'interview-calendar:create:%')
          OR (provider='google_calendar' AND action='cancel_event' AND operation_key LIKE 'interview-calendar:cancel:%')
          OR (provider='notion' AND action='sync_interview' AND operation_key LIKE 'interview-notion:confirmed:%')
          OR (provider='notion' AND action='cancel_interview' AND operation_key LIKE 'interview-notion:canceled:%')
          OR (provider='google_calendar' AND action='reschedule_create' AND operation_key LIKE 'interview-reschedule:create:%')
          OR (provider='gmail' AND action='send_message' AND (operation_key LIKE 'interview-mail:confirmation:%' OR operation_key LIKE 'interview-mail:cancellation:%' OR operation_key LIKE 'interview-mail:reschedule:%' OR operation_key LIKE 'interview-reminder:%'))) 
      ORDER BY j.next_attempt_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1
    )
    UPDATE interview.integration_outbox j SET state='processing',attempts=j.attempts+1,
      lease_until=now()+interval '120 seconds',updated_at=now()
    FROM candidate WHERE j.id=candidate.id
    RETURNING j.id,j.operation_key,j.provider,j.action,j.object_id,j.attempts`;
    const job=rows[0];if(!job)break;
    claimed++;
    const result=await handleProductionCanaryJob(job,{...deps,db});
    const state=result.state==="retry" && job.attempts>=5 ? "reconcile_required" : result.state;
    const delay=Math.min(300,15*2**Math.max(0,job.attempts-1));
    const externalId=result.externalId??null;
    const code=state==="done"?null:result.code??"production_worker_error";
    const applied=await db<{id:string}[]>`UPDATE interview.integration_outbox
      SET state=${state},last_error_code=${code},
        external_id=COALESCE(${externalId},external_id),lease_until=NULL,
        next_attempt_at=CASE WHEN ${state}='retry'
          THEN now()+(${delay}*interval '1 second') ELSE next_attempt_at END,
        updated_at=now()
      WHERE id=${job.id} AND state='processing' AND attempts=${job.attempts}
      RETURNING id`;
    if(applied.length!==1)throw Error("production_worker_lease_lost");
    if(state==="done")done++;
    if(state==="retry")retry++;
    if(state==="reconcile_required")reconciliation++;
  }
  return {claimed,done,reconciliation,retry};
}
