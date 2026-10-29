-- Isolated staging: explicit slot teams and atomic claims for every attendee.
BEGIN;
CREATE TABLE IF NOT EXISTS interview.schedule_slot (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 campus text NOT NULL CHECK(campus IN ('BU','BC')),
 lead_id uuid NOT NULL REFERENCES interview.interviewer(id),
 starts_at timestamptz NOT NULL,
 source_reference text NOT NULL UNIQUE,
 UNIQUE(lead_id,starts_at)
);
CREATE TABLE IF NOT EXISTS interview.schedule_participant (
 slot_id uuid NOT NULL REFERENCES interview.schedule_slot(id),
 participant_id uuid NOT NULL REFERENCES interview.interviewer(id),
 role text NOT NULL CHECK(role IN ('lead','shadow')),
 PRIMARY KEY(slot_id,participant_id)
);
CREATE OR REPLACE FUNCTION interview.sync_reservation_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  DELETE FROM interview.slot_claim WHERE claim_key='reservation:'||OLD.id::text OR starts_with(claim_key,'reservation:'||OLD.id::text||':participant:');
  RETURN OLD;
 END IF;
 DELETE FROM interview.slot_claim WHERE claim_key='reservation:'||NEW.id::text OR starts_with(claim_key,'reservation:'||NEW.id::text||':participant:');
 IF NEW.status IN ('held','calendar_pending','confirmed','reschedule_pending','cancel_pending','reconcile_required') THEN
  INSERT INTO interview.slot_claim VALUES('reservation:'||NEW.id::text,NEW.interviewer_id,NEW.starts_at,NEW.blocks_until);
  INSERT INTO interview.slot_claim
   SELECT 'reservation:'||NEW.id::text||':participant:'||p.participant_id::text,p.participant_id,NEW.starts_at,NEW.blocks_until
   FROM interview.schedule_slot s JOIN interview.schedule_participant p ON p.slot_id=s.id
   WHERE s.lead_id=NEW.interviewer_id AND s.starts_at=NEW.starts_at AND s.campus=NEW.campus AND p.participant_id<>NEW.interviewer_id;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION interview.sync_reschedule_participants() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  INSERT INTO interview.slot_claim
   SELECT 'reschedule:'||NEW.id::text||':participant:'||p.participant_id::text,p.participant_id,NEW.starts_at,
    NEW.ends_at + CASE WHEN (NEW.starts_at AT TIME ZONE 'America/New_York')::date BETWEEN date '2026-11-02' AND date '2026-11-08' THEN interval '0 minutes' ELSE interval '5 minutes' END
   FROM interview.schedule_slot s JOIN interview.schedule_participant p ON p.slot_id=s.id
   WHERE s.lead_id=NEW.interviewer_id AND s.starts_at=NEW.starts_at AND p.participant_id<>NEW.interviewer_id;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER interview_reschedule_participant_claim
 AFTER INSERT ON interview.reschedule_request FOR EACH ROW EXECUTE FUNCTION interview.sync_reschedule_participants();
REVOKE ALL ON interview.schedule_slot,interview.schedule_participant FROM PUBLIC;
COMMIT;
