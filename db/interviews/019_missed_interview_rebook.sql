-- Students who miss an interview can book another time.
-- no_show is terminal: it is outside the active-applicant unique index and
-- the reservation claim trigger, so it releases the one-active-booking lock
-- and the interviewer's slot claim. Completed interviews stay blocked in
-- application code. Do not edit earlier migrations; apply this once.
BEGIN;

DO $$
DECLARE
  name text;
BEGIN
  FOR name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'interview'
      AND rel.relname = 'reservation'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) LIKE '%calendar_pending%'
      AND pg_get_constraintdef(con.oid) LIKE '%expired%'
  LOOP
    EXECUTE format('ALTER TABLE interview.reservation DROP CONSTRAINT %I', name);
  END LOOP;
END $$;

ALTER TABLE interview.reservation
  ADD CONSTRAINT reservation_status_check
  CHECK (status IN (
    'held', 'calendar_pending', 'confirmed', 'reschedule_pending',
    'cancel_pending', 'reconcile_required', 'completed', 'canceled',
    'expired', 'failed', 'no_show'
  ));

-- Drop claims that are not holding a live reservation or a pending replacement.
-- Retired claims left behind after a finished reschedule, and claims for
-- canceled, expired, failed, completed, or no-show rows, were keeping later
-- slots out of the student list and counting against weekly capacity.
DELETE FROM interview.slot_claim sc
WHERE NOT EXISTS (
  SELECT 1 FROM interview.reservation r
  WHERE r.status IN (
      'held','calendar_pending','confirmed','reschedule_pending',
      'cancel_pending','reconcile_required')
    AND (
      sc.claim_key = 'reservation:' || r.id::text
      OR sc.claim_key LIKE 'reservation:' || r.id::text || ':participant:%'
    )
)
AND NOT EXISTS (
  SELECT 1 FROM interview.reschedule_request x
  WHERE x.state IN ('pending','cancel_pending','reconcile_required')
    AND (
      sc.claim_key = 'reschedule:' || x.id::text
      OR sc.claim_key LIKE 'reschedule:' || x.id::text || ':participant:%'
      OR sc.claim_key = 'retired:' || x.id::text
      OR sc.claim_key LIKE 'retired:' || x.id::text || ':participant:%'
    )
);

COMMIT;
