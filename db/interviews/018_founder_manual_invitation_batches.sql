-- Allow founder-initiated, one-day manual interview invitation batches.
-- Does not change the existing 50-recipient limit or the 24-hour expiry.
-- The verified founder must approve an exact recipient set and explicitly press Send.
ALTER TABLE interview.applicant_campaign_manifest
  DROP CONSTRAINT IF EXISTS applicant_campaign_manifest_run_key_check;
ALTER TABLE interview.applicant_campaign_manifest
  ADD CONSTRAINT applicant_campaign_manifest_run_key_check
    CHECK (run_key ~ '^applicant_(friday|sunday|monday):[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       OR run_key ~ '^applicant_manual:[0-9]{4}-[0-9]{2}-[0-9]{2}:[1-9][0-9]?$');
