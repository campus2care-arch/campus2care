-- STAGING SCHEMA PARITY ONLY. Live branch already contains this table.
-- Never copy real applicant recipient HMACs into an isolated test branch.
CREATE TABLE IF NOT EXISTS interview.recipient_suppression (
  recipient_hmac char(64) PRIMARY KEY CHECK (recipient_hmac ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON interview.recipient_suppression FROM PUBLIC;
