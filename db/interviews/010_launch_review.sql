BEGIN;
CREATE TABLE IF NOT EXISTS interview.launch_review (
 run_key text PRIMARY KEY,
 reviewed_at timestamptz NOT NULL,
 manifest_sha256 char(64) NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
 candidate_count integer NOT NULL CHECK(candidate_count>=0),
 eligible_count integer NOT NULL CHECK(eligible_count>=0),
 suppressed_count integer NOT NULL CHECK(suppressed_count>=0),
 state text NOT NULL CHECK(state IN ('blocked','ready','authorized','running','complete')),
 production_url text NOT NULL,
 first_available_at timestamptz NOT NULL,
 release_gates jsonb NOT NULL,
 gmail_message_ids jsonb NOT NULL DEFAULT '[]'::jsonb
);
REVOKE ALL ON interview.launch_review FROM PUBLIC;
COMMIT;
