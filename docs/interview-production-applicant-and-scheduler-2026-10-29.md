# Campus2Care production applicant portal and autonomous scheduler

**Engineering snapshot: October 29, 2026. This PR is NOT a launch authorization.**

## Completed on draft PR #28

- Separate `/api/interview/live/*` authenticated-by-invitation endpoints: status, slots, hold, cancel, reschedule, opt-out, and one-time email verification. The shared UI selects live routes only when `productionRealEnabled()` passes all independent release switches.
- Booking remains transactional, tied to an actual Notion applicant identity and approved campus/team/slot, with live Calendar conflict checks, lead/shadower attendance, and Calendar -> Notion -> Gmail transactional outbox.
- The production outbox now handles transactional 24-hour appointment reminders, unique by reservation ID and interview start instant. A duplicate cron execution cannot insert another reminder message.
- The operational staff queue evaluates Wednesday 3 PM ET requests, Thursday 6 PM ET reminders and Friday 11 AM ET leadership escalation; it uses a unique dispatch key, Workspace staff login allowlist, and a quarantined Gmail send state so ambiguous provider responses are never blindly resent.
- `POST /api/interview/production-scheduler` requires the separate 40+-character `INTERVIEW_PRODUCTION_SCHEDULER_SECRET` and the explicit production release/scheduler flags. The route advances the durable provider and staff mail queues and writes an audit heartbeat. The workflow `.github/workflows/interview-production-scheduler.yml` can trigger every 15 minutes after deployment to the default branch and opt-in. No scheduled execution is evidenced until a real main-branch run succeeds.

## Required founder-controlled launch switches (keep OFF today)

- `INTERVIEW_LIVE_APPLICANTS_ENABLED` and `INTERVIEW_LIVE_RELEASE_APPROVED`
- Existing `INTERVIEW_PRODUCTION_ENABLED`, `INTERVIEW_BOOKING_ENABLED`, `INTERVIEW_PRODUCTION_WORKER_ADAPTER_READY`, `INTERVIEW_CALENDAR_WRITES_ENABLED`, `INTERVIEW_GMAIL_SENDS_ENABLED`, `INTERVIEW_NOTION_WRITES_ENABLED`, `INTERVIEW_OUTBOX_WORKER_ENABLED`
- `INTERVIEW_PRODUCTION_SCHEDULER_ENABLED` (Vercel production environment and GitHub repository variable), plus `INTERVIEW_PRODUCTION_SCHEDULER_SECRET` (same strong secret as protected Vercel runtime and GitHub Actions secret)
- `INTERVIEW_REAL_VERIFICATION_SENDS_APPROVED`, `INTERVIEW_REAL_STAFF_EMAILS_APPROVED`, and `INTERVIEW_REAL_REMINDERS_APPROVED` for the corresponding real-recipient messages
- GitHub Actions secret `INTERVIEW_PRODUCTION_SCHEDULER_URL` must be exactly `https://www.campus2care.org/api/interview/production-scheduler`. Do not put provider refresh tokens into GitHub Actions.
- `INTERVIEW_PRODUCTION_CANARY_ENABLED` must not be `true` in real-applicant mode; it remains isolated from the separately authorized synthetic test.

## Outstanding release blocker: automated real applicant invitations

The production scheduler presently **reports** due Friday 2 PM, Sunday 5 PM, and Monday 9 AM applicant campaign keys as `unimplementedDispatchKinds` and marks the heartbeat `needs_attention`. It does **not** send invitation emails, enroll applicants, or claim an invitation campaign succeeded. The staged synthetic dispatch is not a production substitute.

Before enabling real invitations, build and test a dedicated production pipeline scanner and enrollment token vault, ensuring current BU/BC Notion status, cross-campus recipient HMAC, opt-outs, withdrawals, prior interview bookings, previously delivered manual mail, 48-hour spacing, at most two routine sends in a rolling seven days, a bounded launch manifest, and fresh capacity. Keep applicant sends explicitly disabled until a reviewed exact-recipient manifest and founder approval exist. An expired or uncertain Gmail send must go to `reconcile_required`, never automatic blind retry.

## Scheduler reliability and test plan

Vercel Hobby cron is limited to one daily invocation, insufficient for frequent appointment jobs. GitHub Actions schedule runs only after the workflow is on the default branch and can be delayed or dropped, so query `interview.audit_event` for `actor_ref='production_scheduler'` and alert if heartbeat age exceeds 30 minutes. Verify running the same dispatch twice creates no duplicate message or booking. Check DST as all workflow times are UTC but policy evaluates America/New_York.

The runner is not enough for GO by itself. Capture real runtime proof of provider refresh, Notion writeback in both BU and BC, calendar lead and shadower attendees, a unique Meet URL, actual email acceptance, cancellation and replacement-preserving reschedule, status refresh, cross-campus isolation, and an autonomous scheduler heartbeat. No real staff/applicant messages or public promotion without explicit permission. Keep PR #28 draft and public site unchanged until approval.
