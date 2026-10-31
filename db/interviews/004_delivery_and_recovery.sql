-- Additive migration for the isolated interview staging branch only.
BEGIN;
ALTER TABLE interview.invitation ADD COLUMN IF NOT EXISTS management_token jsonb;
ALTER TABLE interview.reservation ADD COLUMN IF NOT EXISTS conflict_reason text;
CREATE UNIQUE INDEX IF NOT EXISTS interview_reservation_active_recipient
  ON interview.reservation(recipient_hmac)
  WHERE status IN ('held','calendar_pending','confirmed','reschedule_pending','cancel_pending','reconcile_required');
CREATE TABLE IF NOT EXISTS interview.message (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key text NOT NULL UNIQUE,
  recipient_ref text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('invitation','verification','confirmation','cancellation','ea_request','ea_reminder','leadership_escalation')),
  campus text CHECK (campus IN ('BU','BC')),
  object_id uuid NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','accepted','suppressed','reconcile_required','failed')),
  gmail_message_id text,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS interview.applicant_contact (
  invitation_id uuid PRIMARY KEY REFERENCES interview.invitation(id),
  email text NOT NULL CHECK (email LIKE '%@example.invalid'),
  verification_hash char(64),
  verification_expires_at timestamptz,
  verification_attempts integer NOT NULL DEFAULT 0 CHECK (verification_attempts BETWEEN 0 AND 5),
  verification_requested_at timestamptz,
  opted_out_at timestamptz
);
REVOKE ALL ON ALL TABLES IN SCHEMA interview FROM PUBLIC;
COMMIT;

-- A synthetic invitation may optionally bind to one explicitly isolated Notion page.
CREATE TABLE IF NOT EXISTS interview.notion_staging_binding (
  invitation_id uuid PRIMARY KEY REFERENCES interview.invitation(id),
  campus text NOT NULL CHECK (campus IN ('BU','BC')),
  page_id uuid NOT NULL UNIQUE
);
REVOKE ALL ON interview.notion_staging_binding FROM PUBLIC;
