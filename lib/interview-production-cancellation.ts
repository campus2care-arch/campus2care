import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { productionCanaryConfig, assertProductionCanaryIdentity } from "./interview-production-canary";
import { productionInterviewDatabase } from "./interview-production-db";
import { ProductionBookingError } from "./interview-production-booking";

/** Hold every participant claim until the remote event is acknowledged canceled. */
export async function cancelProductionCanaryBooking(invitationToken: string, reservationId: string, database?: Sql) {
  productionCanaryConfig();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(invitationToken ?? "") ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(reservationId ?? "")) {
    throw new ProductionBookingError("invalid_cancellation_request", 400);
  }
  const db = database ?? productionInterviewDatabase();
  const tokenHash = createHash("sha256").update(invitationToken).digest("hex");
  return db.begin(async tx => {
    const rows = await tx<{id: string; status: string; campus: "BU" | "BC"; notion_page_id: string; email: string}[]>`
      SELECT r.id,r.status,r.campus,r.notion_page_id,c.email FROM interview.reservation r
      JOIN interview.invitation i ON i.id=r.invitation_id
      JOIN interview.applicant_contact c ON c.invitation_id=i.id
      WHERE r.id=${reservationId} AND i.token_hash=${tokenHash} AND i.expires_at>now()
        AND i.revoked_at IS NULL AND i.email_verified_at IS NOT NULL FOR UPDATE OF i,r,c`;
    const row = rows[0];
    if (!row) throw new ProductionBookingError("booking_not_found", 404);
    assertProductionCanaryIdentity(row.campus, row.email, row.notion_page_id);
    if (["canceled", "cancel_pending"].includes(row.status)) return {id: row.id, status: row.status};
    if (!["calendar_pending", "confirmed", "reconcile_required"].includes(row.status)) {
      throw new ProductionBookingError("booking_not_cancelable", 409);
    }
    const replacement = await tx`SELECT id FROM interview.reschedule_request
      WHERE reservation_id=${row.id} AND state IN ('pending','cancel_pending','reconcile_required') FOR UPDATE`;
    if (replacement.length) throw new ProductionBookingError("replacement_cleanup_required", 409);
    const jobs = await tx<{state: string}[]>`SELECT id,state FROM interview.integration_outbox
      WHERE object_id=${row.id} FOR UPDATE`;
    if (jobs.some(job=>job.state==="processing")) throw new ProductionBookingError("booking_operation_in_progress", 409);
    await tx`UPDATE interview.reservation SET status='cancel_pending',revision=revision+1,updated_at=now()
      WHERE id=${row.id}`;
    await tx`UPDATE interview.message SET state='suppressed'
      WHERE object_id=${row.id} AND kind='confirmation' AND state='queued'`;
    await tx`UPDATE interview.integration_outbox SET state='done',last_error_code='canceled_before_send',updated_at=now()
      WHERE object_id=${row.id} AND provider='gmail' AND state IN ('queued','retry')
        AND operation_key=${"interview-mail:confirmation:" + row.id}`;
    await tx`UPDATE interview.integration_outbox SET state='done',last_error_code='canceled_before_dispatch',updated_at=now()
      WHERE object_id=${row.id} AND state IN ('queued','retry') AND operation_key IN
        (${"interview-calendar:create:"+row.id},${"interview-notion:confirmed:"+row.id})`;
    await tx`INSERT INTO interview.integration_outbox(operation_key,provider,action,object_id)
      VALUES(${"interview-calendar:cancel:" + row.id},'google_calendar','cancel_event',${row.id})
      ON CONFLICT(operation_key) DO NOTHING`;
    return {id: row.id, status: "cancel_pending"};
  });
}
