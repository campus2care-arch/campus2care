-- Additive only. Founder-approved, per-recipient waiver of the configurable
-- follow-up frequency limits. Opt-outs, bookings and unresolved sends still block.
BEGIN;
ALTER TABLE interview.applicant_campaign_recipient
  ADD COLUMN IF NOT EXISTS frequency_exception boolean NOT NULL DEFAULT false;
COMMIT;
