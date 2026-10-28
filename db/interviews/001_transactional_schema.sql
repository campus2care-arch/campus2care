-- Campus2Care interview scheduling: transactional foundation, staging only.
-- Apply only to an isolated approved $0 PostgreSQL database after checking the
-- target connection. No production flags, Notion, Google, or email writes here.
-- The EA availability preview still uses its separate private Blob store.
--
-- All appointment instants are timestamptz. Convert America/New_York civil
-- times (including DST folds/gaps) explicitly at the API boundary.

BEGIN;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE SCHEMA IF NOT EXISTS interview;
REVOKE ALL ON SCHEMA interview FROM PUBLIC;

CREATE TABLE IF NOT EXISTS interview.interviewer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_email text NOT NULL,
  display_name text NOT NULL,
  active boolean NOT NULL DEFAULT false,
  role text NOT NULL DEFAULT 'ea'
    CHECK (role IN ('ea', 'coordinator', 'admin')),
  allowed_campuses text[] NOT NULL DEFAULT ARRAY['BU']::text[]
    CHECK (cardinality(allowed_campuses) > 0
      AND allowed_campuses <@ ARRAY['BU','BC']::text[]),
  weekly_capacity_limit integer NOT NULL DEFAULT 0
    CHECK (weekly_capacity_limit >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS interview_interviewer_email
  ON interview.interviewer (lower(workspace_email));

CREATE TABLE IF NOT EXISTS interview.interviewer_template (
  interviewer_id uuid PRIMARY KEY REFERENCES interview.interviewer(id),
  recurring_windows jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(recurring_windows) = 'array'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS interview.interviewer_week (
  interviewer_id uuid NOT NULL REFERENCES interview.interviewer(id),
  week_start date NOT NULL CHECK (extract(isodow FROM week_start) = 1),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'unavailable')),
  confirmed_at timestamptz,
  effective_windows jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(effective_windows) = 'array'),
  date_overrides jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(date_overrides) = 'array'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (interviewer_id, week_start),
  CONSTRAINT interview_week_confirmation_state CHECK (
    (status = 'pending' AND confirmed_at IS NULL)
    OR (status IN ('confirmed','unavailable') AND confirmed_at IS NOT NULL)
  )
);

-- Invitations are private, expiring bearer tokens: only their keyed hashes
-- are stored. The recipient HMAC is stable across campuses for send limits.
CREATE TABLE IF NOT EXISTS interview.invitation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campus text NOT NULL CHECK (campus IN ('BU','BC')),
  notion_page_id text NOT NULL CHECK (length(trim(notion_page_id)) > 0),
  recipient_hmac char(64) NOT NULL
    CHECK (recipient_hmac ~ '^[0-9a-f]{64}$'),
  token_hash char(64) NOT NULL UNIQUE
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  email_verified_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS interview_invitation_applicant
  ON interview.invitation (campus, notion_page_id);

-- Buffers are part of the protected reservation interval. Partial exclusion
-- prevents any overlap for the same EA, not merely equal start timestamps.
-- Concurrent inserts race at the DB constraint; one must fail safely.
CREATE TABLE IF NOT EXISTS interview.reservation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id uuid NOT NULL REFERENCES interview.invitation(id),
  campus text NOT NULL CHECK (campus IN ('BU','BC')),
  notion_page_id text NOT NULL CHECK (length(trim(notion_page_id)) > 0),
  recipient_hmac char(64) NOT NULL
    CHECK (recipient_hmac ~ '^[0-9a-f]{64}$'),
  interviewer_id uuid NOT NULL REFERENCES interview.interviewer(id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  blocks_until timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'held' CHECK (status IN (
    'held', 'calendar_pending', 'confirmed', 'reschedule_pending',
    'cancel_pending', 'reconcile_required', 'completed', 'canceled',
    'expired', 'failed'
  )),
  calendar_id text,
  calendar_event_id text,
  meet_url text,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT interview_reservation_fixed_duration
    CHECK (ends_at = starts_at + interval '20 minutes'),
  CONSTRAINT interview_reservation_buffer
    CHECK (blocks_until >= ends_at
       AND blocks_until <= ends_at + interval '5 minutes'),
  CONSTRAINT interview_calendar_reference_pair
    CHECK ((calendar_id IS NULL) = (calendar_event_id IS NULL)),
  CONSTRAINT interview_invitation_campus_consistency
    UNIQUE (id, campus)
);
CREATE UNIQUE INDEX IF NOT EXISTS interview_reservation_active_applicant
  ON interview.reservation (campus, notion_page_id)
  WHERE status IN ('held','calendar_pending','confirmed',
    'reschedule_pending','cancel_pending','reconcile_required');
CREATE UNIQUE INDEX IF NOT EXISTS interview_reservation_external_event
  ON interview.reservation (calendar_id, calendar_event_id)
  WHERE calendar_event_id IS NOT NULL;
ALTER TABLE interview.reservation
  ADD CONSTRAINT interview_reservation_no_ea_overlap
  EXCLUDE USING gist (
    interviewer_id WITH =,
    tstzrange(starts_at, blocks_until, '[)') WITH &&
  ) WHERE (status IN ('held','calendar_pending','confirmed',
    'reschedule_pending','cancel_pending','reconcile_required'))
  DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX IF NOT EXISTS interview_reservation_by_ea
  ON interview.reservation (interviewer_id, starts_at);

-- Each logical request must be persisted in the same transaction as its
-- reservation/outreach state. Workers claim with FOR UPDATE SKIP LOCKED.
CREATE TABLE IF NOT EXISTS interview.integration_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key text NOT NULL UNIQUE,
  provider text NOT NULL CHECK (provider IN ('google_calendar','gmail','notion')),
  action text NOT NULL,
  object_id uuid NOT NULL,
  payload_ref jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(payload_ref) = 'object'),
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','processing','retry','done',
      'reconcile_required','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_error_code text,
  external_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS interview_outbox_due
  ON interview.integration_outbox (next_attempt_at, id)
  WHERE state IN ('queued','retry');
CREATE INDEX IF NOT EXISTS interview_outbox_stale_lease
  ON interview.integration_outbox (lease_until)
  WHERE state = 'processing';

CREATE TABLE IF NOT EXISTS interview.availability_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interviewer_id uuid NOT NULL REFERENCES interview.interviewer(id),
  week_start date NOT NULL CHECK (extract(isodow FROM week_start) = 1),
  kind text NOT NULL CHECK (kind IN ('wednesday_request','thursday_reminder')),
  token_hash char(64) CHECK (token_hash IS NULL OR token_hash ~ '^[0-9a-f]{64}$'),
  token_expires_at timestamptz,
  last_sent_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (interviewer_id, week_start, kind)
);

-- Dispatches are eligibility checks, not unconditional sends.
CREATE TABLE IF NOT EXISTS interview.dispatch_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_key text NOT NULL UNIQUE,
  job_kind text NOT NULL CHECK (job_kind IN (
    'ea_request','ea_reminder','leadership_escalation',
    'applicant_friday','applicant_sunday','applicant_monday'
  )),
  scheduled_for timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','running','complete','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS interview.outreach_attempt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campus text NOT NULL CHECK (campus IN ('BU','BC')),
  notion_page_id text NOT NULL,
  recipient_hmac char(64) NOT NULL
    CHECK (recipient_hmac ~ '^[0-9a-f]{64}$'),
  campaign_type text NOT NULL CHECK (campaign_type IN (
    'initial_invite','reminder','confirmation','cancellation','reschedule'
  )),
  run_key text NOT NULL,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','sending','sent','failed','suppressed',
      'reconcile_required')),
  sent_at timestamptz,
  gmail_message_id text,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campus, notion_page_id, campaign_type, run_key)
);
CREATE INDEX IF NOT EXISTS interview_outreach_rolling_limit
  ON interview.outreach_attempt (recipient_hmac, sent_at DESC)
  WHERE state = 'sent' AND campaign_type IN ('initial_invite','reminder');

CREATE TABLE IF NOT EXISTS interview.audit_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_ref text NOT NULL,
  action text NOT NULL,
  object_type text NOT NULL,
  object_id text NOT NULL,
  outcome text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS interview_audit_recent
  ON interview.audit_event (created_at DESC);

REVOKE ALL ON ALL TABLES IN SCHEMA interview FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA interview FROM PUBLIC;
COMMIT;
