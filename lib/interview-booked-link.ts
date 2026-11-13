import type { Sql, TransactionSql } from "postgres";

/** Expired links manage their own future booking through its end time, and a
 * missed interview (confirmed or no_show, slot already ended) so the student
 * can book again. null allows only that missed-interview exception.
 * undefined is a status lookup. Completed interviews do not extend the link.
 */
export function bookedInterviewAccess(db: Sql | TransactionSql, reservationId?: string | null) {
  if (reservationId === null) {
    return db`EXISTS (
      SELECT 1 FROM interview.reservation managed
      WHERE managed.invitation_id=i.id AND managed.campus=i.campus
        AND managed.notion_page_id=i.notion_page_id AND managed.recipient_hmac=i.recipient_hmac
        AND managed.status IN ('confirmed','no_show') AND managed.ends_at<=now()
    )`;
  }
  return db`EXISTS (
    SELECT 1 FROM interview.reservation managed
    WHERE managed.invitation_id=i.id AND managed.campus=i.campus
      AND managed.notion_page_id=i.notion_page_id AND managed.recipient_hmac=i.recipient_hmac
      AND (${reservationId ?? null}::uuid IS NULL OR managed.id=${reservationId ?? null}::uuid)
      AND (
        (managed.status IN ('calendar_pending','confirmed','cancel_pending','reconcile_required','canceled')
          AND managed.ends_at>now())
        OR (managed.status IN ('confirmed','no_show') AND managed.ends_at<=now())
      )
  )`;
}
