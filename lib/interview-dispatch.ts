import { createHash, randomBytes, randomUUID } from "node:crypto";
import { interviewDatabase } from "./interview-db";
import { dueInterviewDispatches, routineOutreachDecision } from "./interview-dispatch-policy";
import type { InterviewMessage } from "./interview-email";
import { buildInterviewSlots, type WeeklyConfirmation } from "./interview-availability";
import { easternLocalToInstant } from "./interview-timezone";

/** Explicit staging evaluation. Not installed as a recurring production scheduler. */
export async function dispatchSyntheticInterviewMessages(now=new Date()) {
  if(process.env.VERCEL_ENV!=="preview" || process.env.INTERVIEW_SYNTHETIC_DISPATCH_ENABLED!=="true") throw new Error("synthetic_dispatch_disabled");
  const db=interviewDatabase();
  let queued=0, skipped=0;
  for(const run of dueInterviewDispatches(now)) {
    const result=await db.begin(async(tx)=>{
      const inserted=await tx`INSERT INTO interview.dispatch_run(run_key,job_kind,scheduled_for,state) VALUES(${run.runKey},${run.kind},${now.toISOString()},'running') ON CONFLICT DO NOTHING RETURNING id`;
      if(!inserted.length) return {queued:0,skipped:0};
      const queue=async(recipient:string,objectId:string,payload:Omit<InterviewMessage,"operationKey"|"recipient">,key:string,id=randomUUID())=>{
        await tx`INSERT INTO interview.message(id,operation_key,recipient_ref,kind,campus,object_id,payload)
          VALUES(${id},${key},${recipient},${payload.kind},${payload.campus??null},${objectId},${tx.json(payload)}) ON CONFLICT DO NOTHING`;
        await tx`INSERT INTO interview.integration_outbox(operation_key,provider,action,object_id) VALUES(${key},'gmail','send_message',${id}) ON CONFLICT DO NOTHING`;
      };
      let count=0, suppressions=0;
      if(run.kind.startsWith("ea_") || run.kind==="leadership_escalation") {
        const staff=await tx<{id:string;workspace_email:string;status:string|null}[]>`SELECT i.id,i.workspace_email,w.status FROM interview.interviewer i LEFT JOIN interview.interviewer_week w ON w.interviewer_id=i.id AND w.week_start=${run.weekStart}::date WHERE i.active ORDER BY i.id LIMIT 201 FOR UPDATE OF i,c`;
        if(staff.length>200) throw new Error("roster_dispatch_limit");
        const missing=staff.filter((ea)=>!["confirmed","unavailable"].includes(ea.status??""));
        if(run.kind==="leadership_escalation") {
          await queue("bob@campus2care.org",randomUUID(),{kind:"leadership_escalation",missingCount:missing.length,link:process.env.INTERVIEW_BASE_URL+"/interview/admin"},"dispatch:"+run.runKey);
          count++;
        } else for(const ea of staff) {
          if(ea.workspace_email!=="bob@campus2care.org" || (run.kind==="ea_reminder" && !missing.some((m)=>m.id===ea.id))) {suppressions++;continue;}
          const kind=run.kind==="ea_request"?"ea_request":"ea_reminder";
          await tx`INSERT INTO interview.availability_request(interviewer_id,week_start,kind) VALUES(${ea.id},${run.weekStart}::date,${kind==="ea_request"?"wednesday_request":"thursday_reminder"}) ON CONFLICT DO NOTHING`;
          await queue(ea.workspace_email,ea.id,{kind,link:process.env.INTERVIEW_BASE_URL+"/interview/staff/availability"},"dispatch:"+run.runKey+":"+ea.id); count++;
        }
      } else {
        // A staging applicant is enrolled explicitly through the synthetic invitation route.
        const applicants=await tx<{id:string;campus:"BU"|"BC";notion_page_id:string;recipient_hmac:string;email:string}[]>`SELECT i.id,i.campus,i.notion_page_id,i.recipient_hmac,c.email FROM interview.invitation i JOIN interview.applicant_contact c ON c.invitation_id=i.id
          WHERE i.notion_page_id LIKE 'synthetic-%' AND i.revoked_at IS NULL AND i.expires_at>now() AND i.email_verified_at IS NOT NULL AND c.opted_out_at IS NULL
            AND NOT EXISTS(SELECT 1 FROM interview.reservation r WHERE r.recipient_hmac=i.recipient_hmac AND r.status NOT IN ('canceled','failed','expired')) ORDER BY i.id LIMIT 201 FOR UPDATE OF i,c`;
        if(applicants.length>200) throw new Error("applicant_dispatch_limit");
        for(const applicant of applicants) {
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${applicant.recipient_hmac},0))`;
          const booked=await tx`SELECT id FROM interview.reservation WHERE recipient_hmac=${applicant.recipient_hmac} AND status NOT IN ('canceled','failed','expired') LIMIT 1`;
          if(booked.length){suppressions++;continue;}
          const history=await tx<{state:string;sent_at:Date|null;created_at:Date}[]>`SELECT state,sent_at,created_at FROM interview.outreach_attempt WHERE recipient_hmac=${applicant.recipient_hmac} AND campaign_type IN ('initial_invite','reminder') AND (created_at>now()-interval '7 days' OR state IN ('queued','sending','reconcile_required'))`;
          if(routineOutreachDecision(history.map((a)=>({state:a.state,sentAt:a.sent_at?.toISOString()??null,createdAt:a.created_at.toISOString()})),now.getTime())!=="eligible") {suppressions++;continue;}
          const weeks=await tx<{interviewer_id:string;workspace_email:string;effective_windows:WeeklyConfirmation["recurringWindows"];date_overrides:WeeklyConfirmation["overrides"];confirmed_at:Date;booked:number;weekly_capacity_limit:number}[]>`SELECT i.id AS interviewer_id,i.workspace_email,w.effective_windows,w.date_overrides,w.confirmed_at,i.weekly_capacity_limit,
            (SELECT count(*)::int FROM interview.reservation r WHERE r.interviewer_id=i.id AND (r.starts_at AT TIME ZONE 'America/New_York')::date BETWEEN ${run.weekStart}::date AND (${run.weekStart}::date+6) AND r.status IN ('held','calendar_pending','confirmed','reschedule_pending','cancel_pending','reconcile_required')) AS booked
            FROM interview.interviewer i JOIN interview.interviewer_week w ON w.interviewer_id=i.id WHERE i.active AND ${applicant.campus}=ANY(i.allowed_campuses) AND w.week_start=${run.weekStart}::date AND w.status='confirmed' AND w.confirmed_at IS NOT NULL`;
          const capacity=weeks.some((w)=>w.booked<w.weekly_capacity_limit && buildInterviewSlots({eaId:w.workspace_email,weekStart:run.weekStart,status:"confirmed",confirmedAt:w.confirmed_at.toISOString(),recurringWindows:w.effective_windows,overrides:w.date_overrides}).some((slot)=>{
            try{return easternLocalToInstant(slot.date,slot.startMinute).getTime()>now.getTime()+30*60000;}catch{return false;}
          }));
          if(!capacity) {suppressions++;continue;}
          const token=randomBytes(32).toString("base64url"), key="dispatch:"+run.runKey+":"+applicant.id, messageId=randomUUID();
          await tx`UPDATE interview.invitation SET token_hash=${createHash("sha256").update(token).digest("hex")},expires_at=now()+interval '7 days' WHERE id=${applicant.id}`;
          await tx`INSERT INTO interview.outreach_attempt(id,campus,notion_page_id,recipient_hmac,campaign_type,run_key) VALUES(${messageId},${applicant.campus},${applicant.notion_page_id},${applicant.recipient_hmac},${history.some((h)=>h.state==="sent")?"reminder":"initial_invite"},${run.runKey})`;
          await queue(applicant.email,applicant.id,{kind:"invitation",campus:applicant.campus,link:process.env.INTERVIEW_BASE_URL+"/interview#token="+token},key,messageId); count++;
        }
      }
      await tx`UPDATE interview.dispatch_run SET state='complete',completed_at=now() WHERE run_key=${run.runKey}`;
      await tx`INSERT INTO interview.audit_event(actor_ref,action,object_type,object_id,outcome,metadata) VALUES('scheduler','dispatch','run',${run.runKey},'complete',${tx.json({queued:count,skipped:suppressions})})`;
      return {queued:count,skipped:suppressions};
    });
    queued+=result.queued;skipped+=result.skipped;
  }
  return {queued,skipped};
}
