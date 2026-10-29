# Production booking implementation: first canary increment (October 29, 2026)

## Current status: CODE UNDER TEST; NOT LIVE

This increment starts the actual production booking service without reusing the synthetic preview service. It is on draft PR #28, not on production main.

### New source
- `lib/interview-production-canary.ts`: requires production branch/environment and explicit canary flags; blocks organization-wide outreach/enrollment, demands healthy provider switches and worker readiness; limits test traffic to at most five specifically approved `@campus2care.org` addresses **and** up to five exact test Notion page IDs.
- `lib/interview-production-db.ts`: separate Neon production DB client with host validation; no preview DB connection is repurposed.
- `lib/interview-production-notion.ts`: live Notion GET-only identity and eligibility read. Validates exact applicant page ID, correct BU/BC pipeline, email, scheduling stage and interview status; refuses withdrawn, already booked, or otherwise ineligible records. Requires protected `INTERVIEW_NOTION_LIVE_TOKEN`.
- `lib/interview-production-calendar.ts`: independent Google Calendar OAuth refresh token, verifies the token belongs to `interviews@campus2care.org`, then checks every lead/shadower calendar free/busy. Denies unavailable or unreadable calendars; no events are created by this adapter.
- `lib/interview-production-booking.ts`: production canary only. Requires an email-verified invitation in the DB, live Notion eligibility, founder-approved Nov 2–8 slot, approved lead/shadow participants, Calendar free/busy, and weekly cap. Locks the invitation and lead, rechecks team revision inside a transaction, inserts 20-minute reservation, and enqueues exactly one Calendar creation operation in the same transaction. Database exclusion/slot-claim constraints protect against overlapping lead or shadower reservations. Does not mark a booking confirmed.
- `app/api/interview/production/hold/route.ts`: dedicated canary-only POST endpoint with strict same-origin and request-size checks. Missing canary configuration returns 404. This is NOT the public booking interface.

### Important incomplete dependencies

**Do not enable** `INTERVIEW_PRODUCTION_WORKER_ADAPTER_READY`. That marker represents a production provider worker **not yet implemented**. Existing Gmail, Google Calendar event creation, outbox processing and Notion write adapters are preview/synthetic-only and must not be reused to process real applicants. The new hold service refuses to start unless that marker is explicitly configured together with all relevant provider flags.

The existing live website still has production booking and bulk outreach disabled. It has not been merged with draft PR #28.

For an actual production canary, remaining steps include:
1. Build provider-specific production Calendar event creation/cancellation with deterministic event IDs and the full lead, assigned shadows and verified applicant as attendees, and unique Meet links.
2. Build production Gmail confirmation/verification/reminder adapter and production Notion writeback with the already verified BU/BC schema; preserve EA Owner, notes and volunteer placement data.
3. Build a durable production outbox worker and its job authorization, separate from staging synthetic workers, with recovery for ambiguous Google/Gmail outcomes, reconcile-on-retry and appropriate alerts.
4. Test full production email verification (before booking), Calendar event confirmation, follow-up mail and Notion record sync with isolated, explicitly approved canary accounts and test Notion rows. Provide cancellation/rescheduling and cleanup.
5. Test same-slot races and shadow overlaps against a safe disposable database branch; ensure failure rolls back both reservation and outbox operation.
6. Review server rate limiting, durable cancellation tokens, staging/prod credential separation, explicit release/rollback and standalone scheduler heartbeat.
7. Perform final read-only canary preflight before production flags, then get explicit launch approval. Never turn on actual applicant outreach based on unit tests alone.

### Flags and account boundaries
- `INTERVIEW_PRODUCTION_CANARY_ENABLED=true` requires additional gates, and the allowlist is **email AND page ID**; neither list may be empty.
- `INTERVIEW_PRODUCTION_WORKER_ADAPTER_READY=true` must remain **unset/false** until real production adapters and a tested worker exist.
- `INTERVIEW_PRODUCTION_CALENDAR_READS_ENABLED` and `INTERVIEW_PRODUCTION_CALENDAR_REFRESH_TOKEN` are separate from the preview OAuth token.
- `INTERVIEW_NOTION_LIVE_TOKEN` must be a production-scoped server credential; do not use preview synthetic clone tokens.
- Real-application email and Calendar credentials must not be exposed in source, logs, browser bundles, or chat.

### Safety note
This is an implementation milestone, **not a claim that a real applicant can book yet**. The service is dormant by default. Full operations and live canary readiness remain NO-GO until provider integrations and end-to-end verification are completed.
