import type { Sql } from "postgres";
import type { Job, JobResult, WorkerServices } from "./interview-production-worker";
import { assertProductionCanaryIdentity } from "./interview-production-canary";
import { verifyLiveCanaryApplicant } from "./interview-production-notion";
import { readInterviewTeams, teamForSlot, lockInterviewTeamWeeks } from "./interview-teams";
import { createOrReadProductionInterviewEvent, syncProductionInterviewNotion,
  cancelProductionInterviewEvent, ProductionProviderError } from "./interview-production-providers";
import { deliverQueuedProductionMessage } from "./interview-production-mail";

type Replacement = {
  id:string;reservation_id:string;interviewer_id:string;starts_at:Date;ends_at:Date;state:string;original_calendar_key:string;
  campus:"BU"|"BC";notion_page_id:string;email:string;status:string;calendar_operation_key:string|null;
  current_start:Date;current_meet:string|null;current_interviewer:string;
};

/** The original remains confirmed until replacement Meet + Notion sync succeed. */
export async function handleProductionRescheduleJob(job:Job, db:Sql, deps:WorkerServices):Promise<JobResult> {
  const rows=await db<Replacement[]>`SELECT x.*,r.campus,r.notion_page_id,c.email,r.status,r.calendar_operation_key,
    r.starts_at AS current_start,r.meet_url AS current_meet,i.workspace_email AS current_interviewer
    FROM interview.reschedule_request x JOIN interview.reservation r ON r.id=x.reservation_id
    JOIN interview.invitation inv ON inv.id=r.invitation_id
    JOIN interview.applicant_contact c ON c.invitation_id=inv.id
    JOIN interview.interviewer i ON i.id=r.interviewer_id
    WHERE x.id=${job.object_id} AND inv.revoked_at IS NULL AND inv.email_verified_at IS NOT NULL`;
  const hold=rows[0];
  if(!hold)return {state:"failed",code:"production_replacement_missing"};
  assertProductionCanaryIdentity(hold.campus,hold.email,hold.notion_page_id);
  const key="interview-calendar:reschedule:"+hold.id;
  if(job.provider==="gmail") {
    if(hold.state!=="completed" || hold.status!=="confirmed" || hold.calendar_operation_key!==key || !hold.current_meet)
      return {state:"reconcile_required",code:"production_replacement_message_stale"};
    return deliverQueuedProductionMessage(db,hold.id,{
      operationKey:job.operation_key,rescheduleId:hold.id,reservationId:hold.reservation_id,
      campus:hold.campus,pageId:hold.notion_page_id,email:hold.email,
      startsAt:hold.starts_at.toISOString(),meetUrl:hold.current_meet,
    },deps.sendGmail);
  }
  if(!["pending","completed"].includes(hold.state) || hold.status!=="confirmed")
    return {state:"reconcile_required",code:"production_replacement_state_changed"};
  if(hold.state==="pending") {
    if((hold.calendar_operation_key??"interview-calendar:create:"+hold.reservation_id)!==hold.original_calendar_key || !hold.current_meet)
      return {state:"reconcile_required",code:"production_original_changed"};
    const team=teamForSlot(await readInterviewTeams(db),hold.interviewer_id,hold.starts_at.toISOString(),hold.campus);
    if(!team || team.approvedBy!=="president@campus2care.org" || team.participants.some(p=>!p.available))
      return {state:"reconcile_required",code:"production_replacement_team_changed"};
    await (deps.verifyApplicant??verifyLiveCanaryApplicant)({campus:hold.campus,pageId:hold.notion_page_id,email:hold.email,reservationId:hold.reservation_id});
    const event=await (deps.createEvent??createOrReadProductionInterviewEvent)({
      operationKey:key,rescheduleId:hold.id,reservationId:hold.reservation_id,
      campus:hold.campus,pageId:hold.notion_page_id,applicantEmail:hold.email,
      participants:team.participants.map(p=>({email:p.email,role:p.role})),
      startsAt:hold.starts_at.toISOString(),endsAt:hold.ends_at.toISOString(),
    });
    if(event.status!=="confirmed")return {state:"reconcile_required",code:"production_replacement_event_canceled"};
    if(!event.meetUrl)return {state:"retry",code:"production_replacement_meet_pending"};
    await (deps.syncNotion??syncProductionInterviewNotion)({
      campus:hold.campus,pageId:hold.notion_page_id,applicantEmail:hold.email,reservationId:hold.reservation_id,
      startsAt:hold.starts_at.toISOString(),interviewerEmail:team.participants.find(p=>p.role==="lead")!.email,meetUrl:event.meetUrl,
      previous:{startsAt:hold.current_start.toISOString(),interviewerEmail:hold.current_interviewer,meetUrl:hold.current_meet},
    });
    await db.begin(async tx=>{
      await tx`SELECT inv.id FROM interview.invitation inv JOIN interview.reservation r ON r.invitation_id=inv.id
        WHERE r.id=${hold.reservation_id} FOR UPDATE OF inv`;
      const lead=await tx<{active:boolean;allowed_campuses:string[]}[]>`SELECT active,allowed_campuses
        FROM interview.interviewer WHERE id=${hold.interviewer_id} FOR UPDATE`;
      const current=await tx<{status:string;calendar_operation_key:string|null}[]>`SELECT status,calendar_operation_key FROM interview.reservation
        WHERE id=${hold.reservation_id} FOR UPDATE`;
      const request=await tx<{state:string}[]>`SELECT state FROM interview.reschedule_request WHERE id=${hold.id} FOR UPDATE`;
      if(request[0]?.state==="completed" && current[0]?.calendar_operation_key===key)return;
      if(request[0]?.state!=="pending" || current[0]?.status!=="confirmed" ||
          (current[0]?.calendar_operation_key??"interview-calendar:create:"+hold.reservation_id)!==hold.original_calendar_key ||
          !lead[0]?.active || !lead[0].allowed_campuses.includes(hold.campus)) {
        throw new ProductionProviderError("production_replacement_commit_conflict","reconcile_required");
      }
      await lockInterviewTeamWeeks(tx,hold.interviewer_id,hold.starts_at.toISOString());
      const checked=teamForSlot(await readInterviewTeams(tx),hold.interviewer_id,hold.starts_at.toISOString(),hold.campus);
      if(!checked || checked.revision!==team.revision || checked.participants.some(p=>!p.available) ||
          checked.participants.length!==team.participants.length ||
          checked.participants.some(p=>!team.participants.some(old=>old.id===p.id&&old.role===p.role))) {
        throw new ProductionProviderError("production_replacement_team_changed","reconcile_required");
      }
      const claims=await tx<{interviewer_id:string}[]>`SELECT interviewer_id FROM interview.slot_claim
        WHERE claim_key=${"reschedule:"+hold.id} OR starts_with(claim_key,${"reschedule:"+hold.id+":participant:"}) FOR UPDATE`;
      if(claims.length!==team.participants.length || team.participants.some(p=>!claims.some(c=>c.interviewer_id===p.id)))
        throw new ProductionProviderError("production_replacement_claim_missing","reconcile_required");
      await tx`DELETE FROM interview.slot_claim WHERE claim_key=${"reschedule:"+hold.id}
        OR starts_with(claim_key,${"reschedule:"+hold.id+":participant:"})`;
      await tx`UPDATE interview.slot_claim SET claim_key=replace(claim_key,${"reservation:"+hold.reservation_id},${"retired:"+hold.id})
        WHERE claim_key=${"reservation:"+hold.reservation_id} OR starts_with(claim_key,${"reservation:"+hold.reservation_id+":participant:"})`;
      await tx`UPDATE interview.reservation SET interviewer_id=${hold.interviewer_id},starts_at=${hold.starts_at.toISOString()},
        ends_at=${hold.ends_at.toISOString()},blocks_until=${hold.ends_at.toISOString()},calendar_id='interviews@campus2care.org',
        calendar_event_id=${event.id},calendar_operation_key=${key},meet_url=${event.meetUrl},revision=revision+1,updated_at=now()
        WHERE id=${hold.reservation_id}`;
      await tx`UPDATE interview.invitation SET expires_at=GREATEST(expires_at,${new Date(hold.ends_at.getTime()+2*86400000).toISOString()}::timestamptz)
        WHERE id=(SELECT invitation_id FROM interview.reservation WHERE id=${hold.reservation_id})`;
      await tx`UPDATE interview.reschedule_request SET state='completed',updated_at=now() WHERE id=${hold.id}`;
    });
  } else if(hold.calendar_operation_key!==key) {
    return {state:"reconcile_required",code:"production_replacement_superseded"};
  }
  // Even after a crash following the DB switch, retry cleans the original by its stored key.
  await (deps.cancelEvent??cancelProductionInterviewEvent)({campus:hold.campus,pageId:hold.notion_page_id,
    applicantEmail:hold.email,operationKey:hold.original_calendar_key});
  const mailKey="interview-mail:reschedule:"+hold.id;
  await db.begin(async tx=>{
    await tx`DELETE FROM interview.slot_claim WHERE claim_key=${"retired:"+hold.id}
      OR starts_with(claim_key,${"retired:"+hold.id+":participant:"})`;
    await tx`INSERT INTO interview.message(operation_key,recipient_ref,kind,campus,object_id,payload)
      VALUES(${mailKey},${hold.email},'confirmation',${hold.campus},${hold.id},'{}'::jsonb) ON CONFLICT(operation_key) DO NOTHING`;
    await tx`INSERT INTO interview.integration_outbox(operation_key,provider,action,object_id)
      VALUES(${mailKey},'gmail','send_message',${hold.id}) ON CONFLICT(operation_key) DO NOTHING`;
  });
  return {state:"done",externalId:hold.reservation_id};
}
