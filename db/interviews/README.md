# Campus2Care interview booking database (draft PR #28)

**State:** SQL committed as a proposed staging migration. It has **not** been
applied to a live database, and it does **not** activate scheduling.

## Current infrastructure check (2026-10-28)

- The `neon` Vercel Marketplace integration is installed for the
  `campus2care-archs-projects` team under the explicitly selected **Free**
  plan. The Vercel integration configuration reported **zero linked projects**.
- The interview preview branch has existing staff OAuth / Blob configuration,
  but **no database URL** was present in the branch's Vercel environment
  variable names at this check.
- The preview EA portal still stores **only staff availability** in isolated
  private Vercel Blob; this new database is reserved for transactional
  interview booking and a durable integration outbox.
- Do not infer that an installed integration is an actual provisioned database.

## Safe staging setup

1. Verify the Neon provisioning status in Vercel and Neon. Reuse a provisioned
   free database if present; do not create duplicates or enable a paid plan.
2. Create/identify a **staging-only** Neon PostgreSQL database without linking
   it to the live production deployment. Save the connection string as a
   server-only, exact-branch environment variable; use a dedicated
   `INTERVIEW_DATABASE_URL` (or documented equivalent), not the existing
   volunteer application's storage settings. Do not paste URLs/secrets into
   chat, GitHub, logs, or client bundles.
3. Review `001_transactional_schema.sql` before applying it **once** to the
   isolated staging DB. Use a migration ledger/versioning mechanism before
   subsequent releases; this file is not intended to be silently rerun.
4. Run `002_schema_smoke_test.sql` on disposable staging after the migration.
   It creates synthetic accounts and reservations inside a transaction and
   **ROLLBACK**s. Verify the PASS notice. It covers overlapping EA buffer
   intervals, active booking duplication, invitation campus mismatch, outbox
   operation idempotency, and cancellation behavior.
5. Add a server-only Postgres driver and repository adapter; do not expose DB
   credentials or use broad anonymous database grants. Transactionally insert
   reservations and outbox rows. Recheck invitation, Notion eligibility,
   campus, EA active role, confirmed weekly capacity and calendar busy state
   immediately before inserting a hold.
6. Handle PostgreSQL exclusion violation `23P01` as **slot unavailable** and
   unique violation `23505` as **already booked / duplicate request**. These
   constraints protect against concurrent requests across Vercel instances.
   Never retry a rejected reservation as though it succeeded.
7. Implement an authenticated outbox worker with leases, retry backoff,
   provider idempotency and reconciliation of ambiguous Google/Gmail/Notion
   responses. Do not dispatch external side effects inside an open DB
   transaction. The current migration provides the queue tables, **not** the
   worker itself.
8. Implement recipient-level transactions / locking when enforcing a
   48-hour spacing and rolling-seven-day limit across BU and BC. The
   `outreach_attempt` index helps query sent history; the database cannot
   enforce those temporal limits with a simple unique index.
9. Store invitation tokens only as hashes and email identity as a
   **server-secret-keyed HMAC**, not a raw unsalted hash. Never store plaintext
   applicant email or Google access tokens in the audit or outbox tables.
10. Continue with Calendar/Meet, Gmail, and campus-specific Notion integration
    only using synthetic staging data. Confirm expected Notion property names
    and no incidental BU/BC cross-routing before activating any writes.

## Safety and release gates

- Existing `/application`, `/availability`, existing BU/BC Notion
  application routing, and `/api/submissions/replay` must remain untouched.
- Do not merge PR #28 or add production secrets before explicit approval.
- Keep `INTERVIEW_BOOKING_ENABLED=false`,
  `INTERVIEW_OUTREACH_ENABLED=false`, and
  `INTERVIEW_CALENDAR_WRITES_ENABLED=false`.
- **No applicant emails, Google events, production Notion mutations, or
  payment/plan upgrades** are authorized by this migration.
- Verify PostgreSQL syntax and integration tests on the real staging DB. The
  SQL files have been committed but not executed against Neon as of this note.

## Schema design notes

- `interviewer` / `interviewer_week` model active campus permissions and
  explicitly confirmed weekly capacity (missing week is not bookable).
- `invitation` binds a verified recipient to a single BU/BC Notion profile;
  `reservation` has a composite foreign key preventing campus/profile
  substitution.
- `reservation` protects **20-minute events plus up to 5-minute buffers**:
  its PostgreSQL exclusion constraint prevents **overlapping intervals for
  one EA**, while its partial unique index prevents duplicate active
  bookings for the same campus applicant.
- `integration_outbox` holds retryable provider work with stable
  `operation_key`; `dispatch_run` provides scheduling-run idempotency.
- `outreach_attempt` records per-applicant campaigns, and a shared
  `recipient_hmac` enables BU/BC-wide frequency-limit checks.
- `audit_event` must contain only minimal, non-sensitive references.

See `docs/interview-scheduling.md` for the full booking UX and release plan.

## Verified staging checkpoint (2026-10-28)

- Confirmed Neon project `campus2care-interviews-preview-db` (`floral-wave-40595245`) existed on the free Marketplace integration; no application tables initially existed.
- Created an **isolated non-default** Neon branch `interview-staging-20261028` (`br-steep-tooth-b8x1b5gz`), parent `main`. The Neon main branch was left unchanged.
- Applied all 25 non-transaction-wrapper statements from `001_transactional_schema.sql` in one database transaction to **staging only**, successfully.
- Ran the `002_schema_smoke_test.sql` DO-block assertions in a transaction with explicit synthetic-data cleanup. All assertions completed, covering interviewer overlap/buffers, one active applicant reservation, campus identity, outbox idempotency, and cancellation. A separate SELECT confirmed **zero** interviewer, invitation, reservation, or outbox rows remained. The original rollback-only smoke script is unchanged; the connector executes one statement per prepared call, hence the explicit cleanup transaction.
- Created the exact-branch, server-only **sensitive** Vercel environment variable `INTERVIEW_DATABASE_URL` for the PR preview. Its value is **not** committed here. Verify this variable is present and points to the staging branch before deployment; do not set it in production.
- **Pending:** install a compatible PostgreSQL driver and transactional adapter, run the deployed connection health check, verify Vercel deployment, implement invitation/booking APIs, outbound integrations and end-to-end tests. No live booking/notifications/Google Calendar/Notion writes were activated.
- Cost requirement remains: no plan upgrade or paid resource was requested. Monitor Neon free-tier compute/branch usage; the presence of a free plan does not establish that every future workload is free.
