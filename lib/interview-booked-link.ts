import type { Sql, TransactionSql } from "postgres";

/** Expired links manage only their own booked interview, through its end time.
 * null disables the exception for a new booking; undefined is status lookup. */
export function bookedInterviewAccess(db: Sql | TransactionSql, reservationId?: string | null) {
  if (reservationId === null) return false;
  return db`EXISTS (
    SELECT 1 FROM interview.reservation managed
    WHERE managed.invitation_id=i.id AND managed.campus=i.campus
      AND managed.notion_page_id=i.notion_page_id AND managed.recipient_hmac=i.recipient_hmac
      AND (${reservationId ?? null}::uuid IS NULL OR managed.id=${reservationId ?? null}::uuid)
      AND managed.status IN ('calendar_pending','confirmed','cancel_pending','reconcile_required','canceled')
      AND managed.ends_at>now()
  )`;
}
