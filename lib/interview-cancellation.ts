import { createHash } from "node:crypto";
import { interviewDatabase, requireInterviewStagingBooking } from "./interview-db";
import { InterviewBookingError } from "./interview-booking";

/**
 * Cancel a synthetic, not-yet-dispatched hold. Do not mark an appointment
 * canceled if a Google event might already have been created; such cases
 * require the future Calendar reconciliation worker.
 */
export async function cancelStagingInterviewHold(
  invitationToken: string,
  reservationId: string,
): Promise<{ id: string; status: "canceled" }> {
  requireInterviewStagingBooking();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(invitationToken ?? "") ||
      !/^[0-9a-f-]{36}$/i.test(reservationId ?? "")) {
    throw new InterviewBookingError("invalid_cancellation_request");
  }
  const tokenHash = createHash("sha256").update(invitationToken).digest("hex");
  return interviewDatabase().begin(async (tx) => {
    const rows = await tx<{
      id: string; status: string; calendar_event_id: string | null;
      notion_page_id: string;
    }[]>`
      SELECT r.id, r.status, r.calendar_event_id, r.notion_page_id
      FROM interview.reservation r
      JOIN interview.invitation i ON r.invitation_id = i.id
      WHERE r.id = ${reservationId} AND i.token_hash = ${tokenHash}
      FOR UPDATE OF r, i
    `;
    const row = rows[0];
    if (!row || !row.notion_page_id.startsWith("synthetic-")) {
      throw new InterviewBookingError("booking_not_found", 404);
    }
    if (row.status === "canceled") return { id: row.id, status: "canceled" as const };
    if (row.status !== "calendar_pending" || row.calendar_event_id !== null) {
      throw new InterviewBookingError("cancellation_reconciliation_required", 409);
    }
    const operationKey = "interview-calendar:create:" + row.id;
    const jobs = await tx<{ state: string }[]>`
      SELECT state FROM interview.integration_outbox
      WHERE operation_key = ${operationKey}
      FOR UPDATE
    `;
    if (!jobs[0] || !["queued", "retry"].includes(jobs[0].state)) {
      throw new InterviewBookingError("cancellation_reconciliation_required", 409);
    }
    await tx`
      UPDATE interview.integration_outbox SET state = 'done',
        last_error_code = 'cancelled_before_dispatch', updated_at = now()
      WHERE operation_key = ${operationKey}
    `;
    await tx`
      UPDATE interview.reservation SET status = 'canceled', updated_at = now(),
        revision = revision + 1
      WHERE id = ${row.id}
    `;
    return { id: row.id, status: "canceled" as const };
  });
}
