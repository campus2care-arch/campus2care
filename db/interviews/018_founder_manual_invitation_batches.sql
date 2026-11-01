-- Allow founder-initiated, one-day manual interview invitation batches.
-- A single founder-reviewed batch may include up to 100 people, independent of open slots.
-- The verified founder must approve an exact recipient set and explicitly press Send.
ALTER TABLE interview.applicant_campaign_manifest
  DROP CONSTRAINT IF EXISTS applicant_campaign_manifest_run_key_check;
ALTER TABLE interview.applicant_campaign_manifest
  ADD CONSTRAINT applicant_campaign_manifest_run_key_check
    CHECK (run_key ~ '^applicant_(friday|sunday|monday):[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       OR run_key ~ '^applicant_manual:[0-9]{4}-[0-9]{2}-[0-9]{2}:[1-9][0-9]?$');

-- Invitation count is independent of booked-slot capacity; bookings remain constrained
-- to approved interviewer/shadower availability. Keep a bounded 100-recipient maximum.
ALTER TABLE interview.applicant_campaign_manifest
  DROP CONSTRAINT IF EXISTS applicant_campaign_manifest_expected_count_check;
ALTER TABLE interview.applicant_campaign_manifest
  ADD CONSTRAINT applicant_campaign_manifest_expected_count_check
    CHECK (expected_count BETWEEN 1 AND 100);
