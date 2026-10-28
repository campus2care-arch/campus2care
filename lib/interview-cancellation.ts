import { createHash } from "node:crypto";
import { interviewDatabase, requireInterviewStagingBooking } from "./interview-db";
import { InterviewBookingError } from "./interview-booking";

/** Retain the reservation lock until Calendar cancellation is acknowledged. */
export async function cancelStagingInterviewHold(invitationToken:string, reservationId:string): Promise<{id:string;status:"canceled"|"cancel_pending"}> {
  requireInterviewStagingBooking();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(invitationToken ?? "") || !/^[0-9a-f-]{36}$/i.test(reservationId ?? "")) throw new InterviewBookingError("invalid_cancellation_request");
  const tokenHash = createHash("sha256").update(invitationToken).digest("hex");
  return interviewDatabase().begin(async (tx) => {
    const rows = await tx<{id:string;status:string;calendar_event_id:string|null;notion_page_id:string}[]>`
      SELECT r.id,r.status,r.calendar_event_id,r.notion_page_id FROM interview.reservation r
      JOIN interview.invitation i ON r.invitation_id=i.id
      WHERE r.id=${reservationId} AND i.token_hash=${tokenHash}
        AND i.revoked_at IS NULL AND i.expires_at > now() AND i.email_verified_at IS NOT NULL
      FOR UPDATE OF r,i`;
    const row = rows[0];
    if (!row?.notion_page_id.startsWith("synthetic-")) throw new InterviewBookingError("booking_not_found",404);
    if (row.status === "canceled" || row.status === "cancel_pending") return {id:row.id,status:row.status};
    if (!["calendar_pending","confirmed","reconcile_required","reschedule_pending"].includes(row.status)) throw new InterviewBookingError("booking_not_cancelable",409);
    const jobs = await tx<{state:string;attempts:number}[]>`SELECT state,attempts FROM interview.integration_outbox WHERE operation_key=${"interview-calendar:create:" + row.id} FOR UPDATE`;
    // Only a never-attempted create is safe to discard without provider read-back.
    const undispatched = !row.calendar_event_id && jobs[0]?.state === "queued" && jobs[0].attempts === 0;
    if (undispatched) await tx`UPDATE interview.integration_outbox SET state='done',last_error_code='cancelled_before_dispatch',updated_at=now() WHERE operation_key=${"interview-calendar:create:" + row.id}`;
    else await tx`INSERT INTO interview.integration_outbox(operation_key,provider,action,object_id)
      VALUES (${"interview-calendar:cancel:" + row.id},'google_calendar','cancel_event',${row.id}) ON CONFLICT DO NOTHING`;
    await tx`UPDATE interview.reservation SET status=${undispatched ? "canceled" : "cancel_pending"},revision=revision+1,updated_at=now() WHERE id=${row.id}`;
    // Do not deliver a queued confirmation after cancellation was requested.
    await tx`UPDATE interview.message SET state='suppressed' WHERE object_id=${row.id} AND kind='confirmation' AND state='queued'`;
    return {id:row.id,status:undispatched ? "canceled" as const : "cancel_pending" as const};
  });
}
