-- Apply only to the isolated PR #28 Neon staging branch. No production access.
CREATE TABLE IF NOT EXISTS interview.google_provider_credential (
  provider text PRIMARY KEY CHECK (provider IN ('calendar','gmail')),
  account_email text NOT NULL,
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL CHECK (octet_length(iv) = 12),
  tag bytea NOT NULL CHECK (octet_length(tag) = 16),
  granted_scopes jsonb NOT NULL CHECK (jsonb_typeof(granted_scopes) = 'array'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((provider='calendar' AND account_email='interviews@campus2care.org')
    OR (provider='gmail' AND account_email='contact@campus2care.org'))
);
REVOKE ALL ON interview.google_provider_credential FROM PUBLIC;
