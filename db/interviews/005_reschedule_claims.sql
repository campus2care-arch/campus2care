-- Isolated staging only. Atomic additive migration, preserving reservation history.
BEGIN;
ALTER TABLE interview.reservation ADD COLUMN IF NOT EXISTS calendar_operation_key text;
CREATE TABLE IF NOT EXISTS interview.slot_claim (
  claim_key text PRIMARY KEY,
  interviewer_id uuid NOT NULL REFERENCES interview.interviewer(id),
  starts_at timestamptz NOT NULL,
  blocks_until timestamptz NOT NULL CHECK (blocks_until>starts_at),
  CONSTRAINT interview_claim_no_overlap EXCLUDE USING gist (
    interviewer_id WITH =, tstzrange(starts_at,blocks_until,'[)') WITH &&
  )
);
CREATE TABLE IF NOT EXISTS interview.reschedule_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES interview.reservation(id),
  interviewer_id uuid NOT NULL REFERENCES interview.interviewer(id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at=starts_at+interval '20 minutes'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','completed','cancel_pending','canceled','reconcile_required')),
  original_calendar_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS interview_one_pending_reschedule
  ON interview.reschedule_request(reservation_id) WHERE state IN ('pending','cancel_pending','reconcile_required');
CREATE OR REPLACE FUNCTION interview.sync_reservation_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    DELETE FROM interview.slot_claim WHERE claim_key='reservation:'||OLD.id::text;
    RETURN OLD;
  END IF;
  DELETE FROM interview.slot_claim WHERE claim_key='reservation:'||NEW.id::text;
  IF NEW.status IN ('held','calendar_pending','confirmed','reschedule_pending','cancel_pending','reconcile_required') THEN
    INSERT INTO interview.slot_claim(claim_key,interviewer_id,starts_at,blocks_until)
      VALUES('reservation:'||NEW.id::text,NEW.interviewer_id,NEW.starts_at,NEW.blocks_until);
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER interview_reservation_claim
  AFTER INSERT OR UPDATE OF interviewer_id,starts_at,blocks_until,status OR DELETE ON interview.reservation
  FOR EACH ROW EXECUTE FUNCTION interview.sync_reservation_claim();
INSERT INTO interview.slot_claim(claim_key,interviewer_id,starts_at,blocks_until)
  SELECT 'reservation:'||id::text,interviewer_id,starts_at,blocks_until FROM interview.reservation
  WHERE status IN ('held','calendar_pending','confirmed','reschedule_pending','cancel_pending','reconcile_required')
  ON CONFLICT(claim_key) DO NOTHING;
REVOKE ALL ON interview.slot_claim,interview.reschedule_request FROM PUBLIC;
COMMIT;
