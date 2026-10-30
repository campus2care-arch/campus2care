-- Additive only. Apply through a reviewed migration after the new code passes CI.
-- No migration applied by this PR and no campaigns enabled.
BEGIN;
CREATE TABLE IF NOT EXISTS interview.applicant_campaign_manifest (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_key text NOT NULL UNIQUE CHECK (run_key ~ '^applicant_(friday|sunday|monday):[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  digest char(64) NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  audience_digest char(64) NOT NULL CHECK (audience_digest ~ '^[a-f0-9]{64}$'),
  approved_by text NOT NULL CHECK (approved_by='president@campus2care.org'),
  approved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  expected_count integer NOT NULL CHECK (expected_count BETWEEN 1 AND 50),
  state text NOT NULL DEFAULT 'approved' CHECK (state IN ('approved','running','complete','canceled')),
  CHECK (expires_at <= approved_at + interval '24 hours')
);
CREATE TABLE IF NOT EXISTS interview.applicant_campaign_recipient (
  manifest_id uuid NOT NULL REFERENCES interview.applicant_campaign_manifest(id),
  campus text NOT NULL CHECK (campus IN ('BU','BC')),
  page_id char(32) NOT NULL CHECK (page_id ~ '^[a-f0-9]{32}$'),
  recipient_hmac char(64) NOT NULL CHECK (recipient_hmac ~ '^[a-f0-9]{64}$'),
  manual_reference text NOT NULL CHECK (length(trim(manual_reference)) BETWEEN 8 AND 250),
  state text NOT NULL DEFAULT 'approved' CHECK (state IN ('approved','queued','sent','suppressed','reconcile_required')),
  invitation_id uuid REFERENCES interview.invitation(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(manifest_id,recipient_hmac),
  UNIQUE(manifest_id,campus,page_id),
  CHECK ((state IN ('queued','sent','reconcile_required')) = (invitation_id IS NOT NULL)
    OR state='suppressed')
);
CREATE INDEX IF NOT EXISTS interview_campaign_ready
  ON interview.applicant_campaign_recipient(manifest_id,state);
REVOKE ALL ON interview.applicant_campaign_manifest,interview.applicant_campaign_recipient FROM PUBLIC;
COMMIT;