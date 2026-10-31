-- Isolated, single synthetic Google Calendar -> Notion -> Gmail canary ledger.
-- Never insert real volunteer records, calendar slots, team assignments, or
-- rows into interview.reservation / interview.integration_outbox from this test.
CREATE TABLE IF NOT EXISTS interview.booking_provider_canary (
  id text PRIMARY KEY CHECK (id = 'c2c-bu-booking-canary-20261029'),
  campus text NOT NULL CHECK (campus = 'BU'),
  notion_page_id text NOT NULL CHECK (notion_page_id = '408d6c55a9de81da9063fe9a32d88d9b'),
  recipient_email text NOT NULL CHECK (recipient_email = 'contact+interview-canary-bu@campus2care.org'),
  starts_at timestamptz NOT NULL CHECK (starts_at = timestamptz '2026-11-09 19:00:00+00'),
  state text NOT NULL CHECK (state IN (
    'new', 'creating_event', 'event_created', 'notion_synced',
    'sending_email', 'complete', 'cleanup_started', 'event_canceled',
    'cleaned', 'reconcile_required'
  )),
  calendar_event_id text,
  meet_url text,
  gmail_message_id text,
  email_attempted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE interview.booking_provider_canary IS
  'One isolated production-provider test, never a real interview slot or worker job; no automatic retries of ambiguous external writes.';
