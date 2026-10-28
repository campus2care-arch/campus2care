-- Run AFTER 001_transactional_schema.sql against an isolated disposable
-- PostgreSQL staging database. This test writes only synthetic data and
-- rolls back every change. Never point it at production.
--
-- psql -v ON_ERROR_STOP=1 "$INTERVIEW_STAGING_DATABASE_URL" \
--   -f db/interviews/002_schema_smoke_test.sql

BEGIN;

DO $$
DECLARE
  ea_a uuid;
  ea_b uuid;
  token_a uuid;
  token_b uuid;
  first_reservation uuid;
  overlap_rejected boolean := false;
  duplicate_applicant_rejected boolean := false;
  duplicate_job_rejected boolean := false;
BEGIN
  INSERT INTO interview.interviewer
    (workspace_email, display_name, active, allowed_campuses)
  VALUES
    ('synthetic-ea-a@example.invalid', 'Synthetic EA A', true, ARRAY['BU','BC'])
  RETURNING id INTO ea_a;

  INSERT INTO interview.interviewer
    (workspace_email, display_name, active, allowed_campuses)
  VALUES
    ('synthetic-ea-b@example.invalid', 'Synthetic EA B', true, ARRAY['BU'])
  RETURNING id INTO ea_b;

  INSERT INTO interview.invitation
    (campus, notion_page_id, recipient_hmac, token_hash, expires_at,
     email_verified_at)
  VALUES
    ('BU','synthetic-applicant-a',repeat('a',64),repeat('1',64),
     '2026-12-01T00:00:00Z',now())
  RETURNING id INTO token_a;

  INSERT INTO interview.invitation
    (campus, notion_page_id, recipient_hmac, token_hash, expires_at,
     email_verified_at)
  VALUES
    ('BU','synthetic-applicant-b',repeat('b',64),repeat('2',64),
     '2026-12-01T00:00:00Z',now())
  RETURNING id INTO token_b;

  INSERT INTO interview.reservation
    (invitation_id,campus,notion_page_id,recipient_hmac,interviewer_id,
     starts_at,ends_at,blocks_until,status)
  VALUES
    (token_a,'BU','synthetic-applicant-a',repeat('a',64),ea_a,
     '2026-11-02T14:00:00Z','2026-11-02T14:20:00Z',
     '2026-11-02T14:25:00Z','held')
  RETURNING id INTO first_reservation;

  -- The second applicant cannot book a slot overlapping the EA's buffer.
  BEGIN
    INSERT INTO interview.reservation
      (invitation_id,campus,notion_page_id,recipient_hmac,interviewer_id,
       starts_at,ends_at,blocks_until,status)
    VALUES
      (token_b,'BU','synthetic-applicant-b',repeat('b',64),ea_a,
       '2026-11-02T14:22:00Z','2026-11-02T14:42:00Z',
       '2026-11-02T14:47:00Z','held');
  EXCEPTION WHEN exclusion_violation THEN
    overlap_rejected := true;
  END;

  IF NOT overlap_rejected THEN
    RAISE EXCEPTION 'FAIL: overlapping EA reservation was accepted';
  END IF;

  -- The same applicant cannot hold another active slot with a different EA.
  BEGIN
    INSERT INTO interview.reservation
      (invitation_id,campus,notion_page_id,recipient_hmac,interviewer_id,
       starts_at,ends_at,blocks_until,status)
    VALUES
      (token_a,'BU','synthetic-applicant-a',repeat('a',64),ea_b,
       '2026-11-02T15:00:00Z','2026-11-02T15:20:00Z',
       '2026-11-02T15:25:00Z','calendar_pending');
  EXCEPTION WHEN unique_violation THEN
    duplicate_applicant_rejected := true;
  END;

  IF NOT duplicate_applicant_rejected THEN
    RAISE EXCEPTION 'FAIL: duplicate active applicant booking was accepted';
  END IF;

  -- Distinct applicants can use non-overlapping slots with the same EA.
  INSERT INTO interview.reservation
    (invitation_id,campus,notion_page_id,recipient_hmac,interviewer_id,
     starts_at,ends_at,blocks_until,status)
  VALUES
    (token_b,'BU','synthetic-applicant-b',repeat('b',64),ea_a,
     '2026-11-02T14:25:00Z','2026-11-02T14:45:00Z',
     '2026-11-02T14:50:00Z','held');

  INSERT INTO interview.integration_outbox
    (operation_key,provider,action,object_id)
  VALUES ('synthetic-google-event','google_calendar','create_event',first_reservation);

  BEGIN
    INSERT INTO interview.integration_outbox
      (operation_key,provider,action,object_id)
    VALUES ('synthetic-google-event','google_calendar','create_event',first_reservation);
  EXCEPTION WHEN unique_violation THEN
    duplicate_job_rejected := true;
  END;

  IF NOT duplicate_job_rejected THEN
    RAISE EXCEPTION 'FAIL: duplicate integration operation was accepted';
  END IF;

  -- Cancellation frees the applicant's single-active-booking slot,
  -- while keeping the old reservation row for history.
  UPDATE interview.reservation SET status = 'canceled'
    WHERE id = first_reservation;
  INSERT INTO interview.reservation
    (invitation_id,campus,notion_page_id,recipient_hmac,interviewer_id,
     starts_at,ends_at,blocks_until,status)
  VALUES
    (token_a,'BU','synthetic-applicant-a',repeat('a',64),ea_b,
     '2026-11-02T15:00:00Z','2026-11-02T15:20:00Z',
     '2026-11-02T15:25:00Z','held');

  RAISE NOTICE 'PASS: overlap, applicant uniqueness, job idempotency, and cancellation';
END
$$;

ROLLBACK;
