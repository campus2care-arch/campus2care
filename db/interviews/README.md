# Campus2Care interview booking database (draft PR #28)

**State (2026-10-28):** SQL has been applied and smoke-tested on an **isolated Neon staging branch**, not on Neon main or the production website. This does **not** activate real scheduling.

## Initial infrastructure check (historical; before the staging work below)

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

## Phase B implementation checkpoint (2026-10-28)

**Committed to draft PR #28, not merged:**

- `postgres@3.4.7` is pinned in `package.json` and `package-lock.json` for server-only PostgreSQL transactions.
- `lib/interview-db.ts` provides a Neon-specific, small connection pool, production guard, conflict-code translation, and a non-sensitive schema-health check.
- `/api/interview/admin/database` is an authenticated leadership-only, preview-only health endpoint; a successful compiled deployment is **not** proof the live DB connection has been exercised by an admin login.
- `lib/interview-timezone.ts` handles America/New_York civil-to-UTC conversion and deliberately rejects ambiguous/nonexistent times at daylight-saving changes. Unit tests cover winter/summer offsets and both 2026 transitions.
- `lib/interview-booking.ts` transactionally validates a **preverified, synthetic-only** invitation, active campus-authorized interviewer, confirmed PostgreSQL week, 20-minute slot, weekly capacity, and unique booking constraints. Reservation and Google Calendar outbox entry commit together, with no external requests in the transaction.
- `lib/interview-slots.ts` and `/api/interview/booking/slots` expose synthetic-only candidate times from **confirmed database weeks**, taking active reservations and per-EA capacity into account, without returning applicant information.
- `lib/interview-cancellation.ts` and the cancellation API atomically cancel **undispatched** synthetic holds and suppress their queued Calendar operation. Pending or ambiguously processed Google events remain blocked for reconciliation.
- `/interview` is a branded preview-only slot-selection interface. It removes invitation secrets from browser history, displays Eastern Time, and correctly describes pending holds as **not yet confirmed interviews**.
- The API endpoints fail closed unless `VERCEL_ENV=preview` and `INTERVIEW_BOOKING_ENABLED=true`. The current preview flag is intentionally **false**. No real applicants, student emails, Google events, or Notion writes have been activated.

**Important remaining integration work:** Current EA availability uses private Vercel Blob while booking reads `interview.interviewer_week`. Before enabling any live booking, implement and verify a fail-closed, concurrency-safe availability synchronization or migrate the authoritative week record to PostgreSQL. Also validate real Notion eligibility/identity, invite token issuing and email verification, EA calendar conflicts, Gmail/Calendar/Meet OAuth, outbox reconciliation, and actual applicant confirmations. The present code is a staging foundation, **not** a finished production reservation system.

Do not treat GitHub CI, preview build success, or the SQL smoke test as a substitute for full authenticated, end-to-end staging validation.

## EA weekly availability migration (2026-10-28)

The existing private Vercel Blob store remains the source for **recurring templates**.
The previous staff-week Blob data is not deleted or automatically published as
interview slots. The new `lib/interview-week-db.ts` implements a preview-only,
opt-in PostgreSQL authority for **weekly confirmations**:

- Set `INTERVIEW_WEEK_STORAGE=postgres` **only for the exact PR #28 preview
  branch** after CI and staging database connectivity checks.
- In that mode, newly confirmed weeks are written transactionally to
  `interview.interviewer_week`. New EA rows are created **inactive**, with
  zero capacity; staff login alone does not authorize interviewing.
- When an existing week has no PostgreSQL row, the EA can see the previous
  Blob confirmation, labeled for re-confirmation. A fresh Blob ETag must match
  before its first migration. Existing Blob weeks never become bookable by
  merely being visible.
- After a PostgreSQL week exists, its `db:<revision>` is authoritative; stale
  clients receive HTTP 409. The database row is locked using the same
  interviewer-then-week order as reservations. The prior Blob week remains
  an archival copy.
- A changed week never deletes bookings; active reservations outside the new
  windows are counted for leadership review and manual reassignment.
- Leadership readiness reports SQL-migrated status and excludes inactive,
  zero-capacity, and un-migrated interviewers from potential capacity. It is
  still a **preliminary** count until booked slots and Calendar busy periods
  are subtracted.
- Set `INTERVIEW_WEEK_STORAGE=blob` (or omit it) to revert the preview editor
  to the old Blob-only behavior. That is a temporary development fallback,
  **not** a production rollback strategy once bookings are enabled.

The separate Neon staging branch was checked using a synthetic confirmation
insert, revision update, and forced rollback inside a PL/pgSQL exception
subtransaction; the post-check confirmed zero synthetic rows remained.

**Do not enable `INTERVIEW_BOOKING_ENABLED` yet.** The staging candidate
booking services still lack verified end-to-end Google Calendar conflicts,
real applicant Notion eligibility, invitation delivery, verification, and
outbox processing. Approval of actual EA campus permissions and weekly
capacity is a separate leadership action.

**Preview rollout (2026-10-28):** Exact-branch Vercel environment variable `INTERVIEW_WEEK_STORAGE=postgres` was configured for PR #28 only, after successful tests and a green GitHub CI build. Production has not been changed. A fresh preview deployment and authenticated EA/browser round-trip must be verified before this switch is considered end-to-end tested.
