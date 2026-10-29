import { interviewTeamDescription } from "./interview-teams";
import {checkSyntheticNotionInvitationEligibility,PreviewNotionReadError} from "./interview-notion-preview";
import { createHash } from "node:crypto";
import { interviewDatabase } from "./interview-db";
import { googleProviderAccessToken } from "./interview-google-provider-auth";
import { createSyntheticInterviewCalendarEvent, cancelSyntheticInterviewCalendarEvent, InterviewCalendarProviderError } from "./interview-calendar-provider";
import { sendStagingInterviewMessage, InterviewMailError, type InterviewMessage } from "./interview-email";
import type { InterviewOutboxJob, OutboxResult } from "./interview-outbox";

import {openInterviewSecret} from "./interview-secrets";

import {syncSyntheticNotionInterview} from "./interview-notion-sync";

import {handleRescheduleJob} from "./interview-reschedule-worker";
import {syntheticCalendarAttendees} from "./interview-calendar-attendees";
type Reservation = {
  id:string; interviewer_id:string;status:string; notion_page_id:string; campus:"BU"|"BC";
  starts_at:Date; ends_at:Date; calendar_event_id:string|null;calendar_operation_key?:string|null;
};
/** This adapter has no path to real recipients or live Notion records. */
export async function handleInterviewOutboxJob(job: InterviewOutboxJob): Promise<OutboxResult> {
  if(job.provider==="google_calendar"&&job.action.startsWith("reschedule_"))return handleRescheduleJob(job);
  const db = interviewDatabase();
  if (job.provider === "gmail" && job.action === "send_message") {
    const rows = await db<{ id:string; state:string; recipient_ref:string; object_id:string; payload:InterviewMessage & {secret?:Parameters<typeof openInterviewSecret>[0]} }[]>`
      SELECT id,state,recipient_ref,object_id,payload FROM interview.message WHERE id = ${job.object_id}
    `;
    const message = rows[0];
    if (!message) return { state:"failed", errorCode:"message_not_found" };
    if (message.state === "accepted" || message.state === "suppressed") return { state:"done", externalId:null };
    // Payload never chooses its recipient; persisted synthetic identity is authoritative.
    if (process.env.INTERVIEW_SYNTHETIC_GMAIL_ENABLED !== "true") return { state:"retry", errorCode:"synthetic_gmail_disabled" };
    try {
      const payload={...message.payload};
      if(payload.kind==="invitation") {
        const current=await db<{campus:"BU"|"BC";email:string;page_id:string|null}[]>`SELECT i.campus,c.email,b.page_id::text AS page_id
          FROM interview.invitation i JOIN interview.applicant_contact c ON c.invitation_id=i.id
          LEFT JOIN interview.notion_staging_binding b ON b.invitation_id=i.id AND b.campus=i.campus
          WHERE i.id=${message.object_id} AND i.revoked_at IS NULL AND i.expires_at>now() AND c.opted_out_at IS NULL
            AND NOT EXISTS(SELECT 1 FROM interview.reservation r WHERE r.recipient_hmac=i.recipient_hmac AND r.status NOT IN ('canceled','failed','expired'))`;
        const identity=current[0];
        const eligible=identity&&identity.email===message.recipient_ref&&(!identity.page_id||
          (await checkSyntheticNotionInvitationEligibility(identity.campus,identity.page_id,fetch,identity.email)).eligible);
        if(!eligible){
          await db`UPDATE interview.message SET state='suppressed',payload=payload-'secret' WHERE id=${message.id}`;
          await db`UPDATE interview.outreach_attempt SET state='suppressed' WHERE id=${message.id}`;
          return {state:"done",externalId:null};
        }
      }
      if(payload.kind==="invitation" && payload.secret) payload.link=process.env.INTERVIEW_BASE_URL+"/interview#token="+openInterviewSecret(payload.secret,"invitation:"+message.object_id);
      if(payload.kind==="verification" && payload.secret) {
        payload.verificationCode=openInterviewSecret(payload.secret,"verification:"+message.object_id);
        const current=await db<{verification_hash:string|null}[]>`SELECT c.verification_hash FROM interview.applicant_contact c JOIN interview.invitation i ON i.id=c.invitation_id
          WHERE i.id=${message.object_id} AND i.revoked_at IS NULL AND i.email_verified_at IS NULL AND c.verification_expires_at>now() AND c.opted_out_at IS NULL`;
        if(current[0]?.verification_hash!==createHash("sha256").update(message.object_id+":"+payload.verificationCode).digest("hex")) {
          await db`UPDATE interview.message SET state='suppressed',payload=payload-'secret' WHERE id=${message.id}`;
          return {state:"done",externalId:null};
        }
      }
      if(["confirmation","cancellation","appointment_reminder"].includes(payload.kind)) {
        const identity=await db<{id:string;management_token:Parameters<typeof openInterviewSecret>[0]|null;status:string;starts_at:Date;meet_url:string|null;opted_out_at:Date|null}[]>`SELECT i.id,i.management_token,r.status,r.starts_at,r.meet_url,c.opted_out_at FROM interview.invitation i JOIN interview.reservation r ON r.invitation_id=i.id LEFT JOIN interview.applicant_contact c ON c.invitation_id=i.id WHERE r.id=${message.object_id}`;
        if((payload.kind==="appointment_reminder"&&identity[0]?.opted_out_at)||(["confirmation","appointment_reminder"].includes(payload.kind) && (identity[0]?.status!=="confirmed"||identity[0].starts_at?.toISOString()!==payload.startsAt||identity[0].meet_url!==payload.meetUrl))) {
          await db`UPDATE interview.message SET state='suppressed' WHERE id=${message.id}`;
          return {state:"done",externalId:null};
        }
        if(identity[0]?.management_token) payload.link=process.env.INTERVIEW_BASE_URL+"/interview#token="+openInterviewSecret(identity[0].management_token,"invitation:"+identity[0].id);
      }
      const id = await sendStagingInterviewMessage({ ...payload, operationKey:job.operation_key, recipient:message.recipient_ref }, await googleProviderAccessToken("gmail"));
      await db.begin(async (tx) => {
        await tx`UPDATE interview.message SET state='accepted', gmail_message_id=${id}, accepted_at=now(), payload=payload-'secret' WHERE id=${message.id}`;
        await tx`UPDATE interview.outreach_attempt SET state='sent', sent_at=now(), gmail_message_id=${id} WHERE id=${message.id}`;
      });
      return { state:"done", externalId:id };
    } catch (error) {
      if(error instanceof PreviewNotionReadError)return {state:"retry",errorCode:error.code};
      const ambiguous = !(error instanceof InterviewMailError) || error.ambiguous;
      await db`UPDATE interview.message SET state=${ambiguous ? "reconcile_required" : "failed"} WHERE id=${message.id}`;
      await db`UPDATE interview.outreach_attempt SET state=${ambiguous ? "reconcile_required" : "failed"} WHERE id=${message.id}`;
      return { state:ambiguous ? "reconcile_required" : "failed", errorCode:error instanceof InterviewMailError ? error.code : "gmail_unknown_outcome" };
    }
  }
  if (job.provider === "notion" && job.action === "sync_interview") {
    return db.begin(async(tx):Promise<OutboxResult>=>{
      // Serialize provider writes with booking/cancellation for this invitation.
      await tx`SELECT i.id FROM interview.invitation i JOIN interview.reservation r ON r.invitation_id=i.id WHERE r.id=${job.object_id} FOR UPDATE OF i`;
    const rows=await tx<{campus:"BU"|"BC";page_id:string;id:string;status:string;starts_at:Date;meet_url:string|null;workspace_email:string;email:string}[]>`SELECT r.id,r.campus,r.status,r.starts_at,r.meet_url,b.page_id,i.workspace_email,c.email FROM interview.reservation r
      JOIN interview.applicant_contact c ON c.invitation_id=r.invitation_id
      JOIN interview.notion_staging_binding b ON b.invitation_id=r.invitation_id AND b.campus=r.campus JOIN interview.interviewer i ON i.id=r.interviewer_id
      WHERE r.id=${job.object_id} AND r.notion_page_id LIKE 'synthetic-%'`;
    const row=rows[0];if(!row)return {state:"failed",errorCode:"synthetic_notion_binding_missing"};
    if(!["confirmed","canceled"].includes(row.status))return {state:"retry",errorCode:"notion_booking_not_settled"};
    try {
      await syncSyntheticNotionInterview({campus:row.campus,pageId:row.page_id,reservationId:row.id,status:row.status as "confirmed"|"canceled",startsAt:row.starts_at.toISOString(),meetUrl:row.meet_url,interviewerEmail:row.workspace_email,recipientEmail:row.email});
      return {state:"done",externalId:row.page_id};
    }catch{return {state:"retry",errorCode:"synthetic_notion_sync_failed"};}
    });
  }
  if (job.provider !== "google_calendar" || !["create_event","cancel_event"].includes(job.action)) {
    return { state:"reconcile_required", errorCode:"unsupported_operation" };
  }
  const rows = await db<Reservation[]>`SELECT id,status,notion_page_id,campus,interviewer_id,starts_at,ends_at,calendar_event_id,calendar_operation_key FROM interview.reservation WHERE id=${job.object_id}`;
  const reservation = rows[0];
  if (!reservation?.notion_page_id.startsWith("synthetic-")) return { state:"failed", errorCode:"synthetic_reservation_required" };
  if (process.env.INTERVIEW_SYNTHETIC_CALENDAR_ENABLED !== "true") return { state:"retry", errorCode:"synthetic_calendar_disabled" };
  const operationKey = reservation.calendar_operation_key??"interview-calendar:create:" + reservation.id;
  try {
    const token = await googleProviderAccessToken("calendar");
    if (job.action === "cancel_event") {
      const creating = await db`SELECT id FROM interview.integration_outbox WHERE operation_key=${operationKey} AND state='processing'`;
      if (creating.length) return { state:"retry", errorCode:"calendar_creation_in_progress" };
    }
    if (job.action === "cancel_event" || ["cancel_pending","canceled"].includes(reservation.status)) {
      await cancelSyntheticInterviewCalendarEvent(token, operationKey);
      await db.begin(async (tx) => {
        await tx`UPDATE interview.reservation SET status='canceled', updated_at=now(), revision=revision+1 WHERE id=${reservation.id}`;
        await enqueueMessage(tx, reservation, "cancellation");
      });
      return { state:"done", externalId:reservation.calendar_event_id };
    }
    if (!["calendar_pending","confirmed","reconcile_required"].includes(reservation.status)) return { state:"failed", errorCode:"reservation_state_not_dispatchable" };
    const event = await createSyntheticInterviewCalendarEvent({ accessToken:token, operationKey,
      startsAt:reservation.starts_at.toISOString(), endsAt:reservation.ends_at.toISOString(),teamDescription:await interviewTeamDescription(db,reservation.interviewer_id,reservation.starts_at.toISOString(),reservation.campus),attendees:await syntheticCalendarAttendees(reservation.interviewer_id) });
    if (event.status === "cancelled") return { state:"reconcile_required", errorCode:"calendar_event_already_canceled" };
    // Record identity even if Meet provisioning is pending. A retry reads the deterministic ID.
    await db.begin(async (tx) => {
      const locked = await tx<{ status:string }[]>`SELECT status FROM interview.reservation WHERE id=${reservation.id} FOR UPDATE`;
      const canceled = ["cancel_pending","canceled"].includes(locked[0]?.status);
      await tx`UPDATE interview.reservation SET calendar_id='primary', calendar_event_id=${event.id}, meet_url=${event.meetUrl},
        status=${canceled ? "cancel_pending" : event.meetUrl ? "confirmed" : "calendar_pending"}, updated_at=now(), revision=revision+1 WHERE id=${reservation.id}`;
      if (canceled) {
        await tx`INSERT INTO interview.integration_outbox(operation_key,provider,action,object_id) VALUES
          (${"interview-calendar:cancel:" + reservation.id},'google_calendar','cancel_event',${reservation.id}) ON CONFLICT DO NOTHING`;
      } else if (event.meetUrl) await enqueueMessage(tx, reservation, "confirmation", event.meetUrl);
    });
    return event.meetUrl ? { state:"done", externalId:event.id } : { state:"retry", errorCode:"meet_provisioning_pending" };
  } catch (error) {
    // Deterministic Calendar creates/deletes can be retried safely after read-back.
    if (error instanceof InterviewCalendarProviderError) return { state:"retry", errorCode:error.code };
    return { state:"reconcile_required", errorCode:"calendar_unknown_outcome" };
  }
}

import type { TransactionSql } from "postgres";
async function enqueueMessage(tx: TransactionSql, reservation: Reservation, kind:"confirmation"|"cancellation", meetUrl?:string) {
  await tx`INSERT INTO interview.integration_outbox(operation_key,provider,action,object_id)
    SELECT ${"interview-notion:"+kind+":"+reservation.id},'notion','sync_interview',${reservation.id}
    FROM interview.notion_staging_binding b JOIN interview.reservation r ON r.invitation_id=b.invitation_id AND r.campus=b.campus
    WHERE r.id=${reservation.id} ON CONFLICT DO NOTHING`;
  const key = "interview-mail:" + kind + ":" + reservation.id;
  const messages = await tx<{ id:string }[]>`INSERT INTO interview.message(operation_key,recipient_ref,kind,campus,object_id,payload)
    VALUES (${key},'synthetic@example.invalid',${kind},${reservation.campus},${reservation.id},${tx.json({ kind, campus:reservation.campus, startsAt:reservation.starts_at.toISOString(), ...(meetUrl ? { meetUrl } : {}) })})
    ON CONFLICT(operation_key) DO UPDATE SET operation_key=EXCLUDED.operation_key RETURNING id`;
  await tx`INSERT INTO interview.integration_outbox(operation_key,provider,action,object_id)
    VALUES (${key},'gmail','send_message',${messages[0].id}) ON CONFLICT DO NOTHING`;
}

/** Only replay idempotent Calendar operations. Gmail ambiguous outcomes require a human provider check. */
export async function reconcileInterviewCalendarJob(jobId:string) {
  if (process.env.VERCEL_ENV !== "preview" || !/^[0-9a-f-]{36}$/i.test(jobId)) throw new Error("invalid_reconciliation");
  const db = interviewDatabase();
  const rows = await db`UPDATE interview.integration_outbox SET state='retry', attempts=0, next_attempt_at=now(), lease_until=NULL, last_error_code=NULL, updated_at=now()
    WHERE id=${jobId} AND provider='google_calendar' AND action IN ('create_event','cancel_event','reschedule_create','reschedule_cleanup_old','reschedule_cleanup_new') AND state IN ('failed','reconcile_required') RETURNING id`;
  if (!rows.length) throw new Error("job_not_reconcilable");
}

/** Record an administrator's independently verified Sent-folder evidence. This never sends or requeues mail. */
export async function recordVerifiedGmailAcceptance(jobId:string,gmailMessageId:string){
  if(process.env.VERCEL_ENV!=="preview"||!/^[0-9a-f-]{36}$/i.test(jobId)||!/^[a-f0-9]{8,64}$/i.test(gmailMessageId))throw new Error("invalid_gmail_evidence");
  await interviewDatabase().begin(async(tx)=>{
    const jobs=await tx<{object_id:string}[]>`SELECT object_id FROM interview.integration_outbox WHERE id=${jobId} AND provider='gmail' AND action='send_message' AND state IN ('failed','reconcile_required') FOR UPDATE`;
    const job=jobs[0];if(!job)throw new Error("gmail_job_not_reconcilable");
    await tx`UPDATE interview.message SET state='accepted',gmail_message_id=${gmailMessageId},accepted_at=now(),payload=payload-'secret' WHERE id=${job.object_id}`;
    await tx`UPDATE interview.outreach_attempt SET state='sent',gmail_message_id=${gmailMessageId},sent_at=now(),last_error_code=NULL WHERE id=${job.object_id}`;
    await tx`UPDATE interview.integration_outbox SET state='done',external_id=${gmailMessageId},lease_until=NULL,last_error_code=NULL,updated_at=now() WHERE id=${jobId}`;
    await tx`INSERT INTO interview.audit_event(actor_ref,action,object_type,object_id,outcome) VALUES('admin','record_verified_gmail_acceptance','job',${jobId},'accepted_without_resend')`;
  });
}
