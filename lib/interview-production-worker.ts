import type { Sql } from "postgres";
import { productionCanaryConfig, assertProductionCanaryIdentity } from "./interview-production-canary";
import { productionInterviewDatabase } from "./interview-production-db";
import { readInterviewTeams, teamForSlot } from "./interview-teams";
import {
  createOrReadProductionInterviewEvent, syncProductionInterviewNotion,
  sendProductionInterviewConfirmation, ProductionProviderError,
} from "./interview-production-providers";

type Job = {
  id: string; operation_key: string; provider: string; action: string;
  object_id: string; attempts: number;
};
type Reservation = {
  id: string; campus: "BU" | "BC"; notion_page_id: string;
  interviewer_id: string; starts_at: Date; ends_at: Date; status: string;
  calendar_id: string | null; calendar_event_id: string | null;
  meet_url: string | null; email: string; interviewer_email: string;
};
export type JobResult = { state: "done" | "retry" | "reconcile_required" | "failed"; externalId?: string; code?: string };
export type WorkerServices = {
  db?: Sql;
  createEvent?: typeof createOrReadProductionInterviewEvent;
  syncNotion?: typeof syncProductionInterviewNotion;
  sendGmail?: typeof sendProductionInterviewConfirmation;
};
export function isCanaryJob(job: Job): boolean {
  return (job.provider==="google_calendar" && job.action==="create_event" &&
    job.operation_key==="interview-calendar:create:"+job.object_id) ||
    (job.provider==="notion" && job.action==="sync_interview" &&
    job.operation_key==="interview-notion:confirmed:"+job.object_id) ||
    (job.provider==="gmail" && job.action==="send_message" &&
    job.operation_key==="interview-mail:confirmation:"+job.object_id);
}
function outcome(error: unknown): JobResult {
  if(error instanceof ProductionProviderError)return {state:error.disposition,code:error.code};
  return {state:"reconcile_required",code:"production_provider_outcome_unknown"};
}
async function readReservation(db: Sql, id: string): Promise<Reservation> {
  const rows=await db<Reservation[]>`
    SELECT r.id,r.campus,r.notion_page_id,r.interviewer_id,r.starts_at,r.ends_at,
      r.status,r.calendar_id,r.calendar_event_id,r.meet_url,c.email,
      i.workspace_email AS interviewer_email
    FROM interview.reservation r
      JOIN interview.invitation inv ON inv.id=r.invitation_id
      JOIN interview.applicant_contact c ON c.invitation_id=inv.id
      JOIN interview.interviewer i ON i.id=r.interviewer_id
    WHERE r.id=${id} AND inv.revoked_at IS NULL AND inv.email_verified_at IS NOT NULL
      AND c.opted_out_at IS NULL AND r.status IN ('calendar_pending','confirmed')
  `;
  if(rows.length!==1)throw new ProductionProviderError("production_worker_reservation_missing","failed");
  const res=rows[0];
  assertProductionCanaryIdentity(res.campus,res.email,res.notion_page_id);
  return res;
}
async function runCalendar(job: Job, db: Sql, create: typeof createOrReadProductionInterviewEvent): Promise<JobResult> {
  const res=await readReservation(db,job.object_id);
  if(res.status==="confirmed" && res.calendar_event_id && res.meet_url)
    return {state:"done",externalId:res.calendar_event_id};
  if(res.status!=="calendar_pending")return {state:"reconcile_required",code:"production_calendar_state_conflict"};
  const team=teamForSlot(await readInterviewTeams(db),res.interviewer_id,res.starts_at.toISOString(),res.campus);
  if(!team || team.approvedBy!=="president@campus2care.org" || team.participants.length<2 ||
    team.participants.filter(p=>p.role==="lead").length!==1 ||
    team.participants.some(p=>!p.available))
    return {state:"reconcile_required",code:"production_calendar_team_changed"};
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
  if(res.status!=="confirmed" || !res.meet_url)
    return {state:"retry",code:"production_gmail_not_ready"};
  const messages=await db<{id:string;recipient_ref:string;kind:string;state:string;gmail_message_id:string|null}[]>`
    SELECT id,recipient_ref,kind,state,gmail_message_id FROM interview.message
    WHERE operation_key=${job.operation_key} AND object_id=${res.id}`;
  const msg=messages[0];
  if(!msg || msg.recipient_ref!==res.email || msg.kind!=="confirmation")
    return {state:"failed",code:"production_gmail_message_mismatch"};
  if(msg.state==="accepted" && msg.gmail_message_id)return {state:"done",externalId:msg.gmail_message_id};
  if(msg.state!=="queued")return {state:"reconcile_required",code:"production_gmail_previous_attempt"};
  // Crash after this update requires manual reconciliation, not a second send.
  const locked=await db<{id:string}[]>`UPDATE interview.message SET state='sending'
    WHERE id=${msg.id} AND state='queued' RETURNING id`;
  if(locked.length!==1)return {state:"reconcile_required",code:"production_gmail_attempt_conflict"};
  const id=await send({
    operationKey:job.operation_key,campus:res.campus,pageId:res.notion_page_id,
    email:res.email,reservationId:res.id,startsAt:res.starts_at.toISOString(),
    meetUrl:res.meet_url,
  });
  await db`UPDATE interview.message SET state='accepted',
    gmail_message_id=${id},accepted_at=now() WHERE id=${msg.id} AND state='sending'`;
  return {state:"done",externalId:id};
}
export async function handleProductionCanaryJob(job: Job, deps: WorkerServices = {}): Promise<JobResult> {
  productionCanaryConfig();
  if(!isCanaryJob(job))return {state:"failed",code:"production_worker_unsupported_action"};
  const db=deps.db??productionInterviewDatabase();
  try {
    if(job.provider==="google_calendar")return await runCalendar(job,db,deps.createEvent??createOrReadProductionInterviewEvent);
    if(job.provider==="notion")return await runNotion(job,db,deps.syncNotion??syncProductionInterviewNotion);
    return await runGmail(job,db,deps.sendGmail??sendProductionInterviewConfirmation);
  } catch(e){return outcome(e);}
}
/** Lease jobs atomically. Expired leases are quarantined rather than replayed. */
export async function processProductionCanaryOutbox(
  limit=3,deps: WorkerServices = {},
): Promise<{claimed:number;done:number;reconciliation:number;retry:number}> {
  productionCanaryConfig();
  if(!Number.isInteger(limit)||limit<1||limit>5)throw Error("invalid_production_worker_limit");
  const db=deps.db??productionInterviewDatabase();
  await db`UPDATE interview.integration_outbox SET state='reconcile_required',
    last_error_code='expired_production_lease',lease_until=NULL,updated_at=now()
    WHERE state='processing' AND lease_until<now()
      AND (operation_key LIKE 'interview-calendar:create:%' OR
        operation_key LIKE 'interview-notion:confirmed:%' OR
        operation_key LIKE 'interview-mail:confirmation:%')`;
  let claimed=0,done=0,reconciliation=0,retry=0;
  for(let i=0;i<limit;i++){
    const rows=await db<Job[]>`WITH candidate AS (
      SELECT id FROM interview.integration_outbox
      WHERE state IN ('queued','retry') AND next_attempt_at<=now()
        AND ((provider='google_calendar' AND action='create_event' AND operation_key LIKE 'interview-calendar:create:%')
          OR (provider='notion' AND action='sync_interview' AND operation_key LIKE 'interview-notion:confirmed:%')
          OR (provider='gmail' AND action='send_message' AND operation_key LIKE 'interview-mail:confirmation:%'))
      ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1
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
