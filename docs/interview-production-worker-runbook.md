# Campus2Care production canary integration worker

**Status:** Code implemented on draft PR #28. Not deployed to live main; no production booking, real Calendar event, Gmail, or Notion mutation performed.

## Worker contract

- Trigger: administrator-only `POST /api/interview/admin/production-worker`, requiring a verified Workspace administrator session, exact same-origin request, and explicit production canary flags.
- Source: `interview.integration_outbox` in the **production** Neon branch. Claims are limited to the two allowlists (test Workspace email AND test Notion page ID), exact allowed provider/action/operation keys, and `FOR UPDATE SKIP LOCKED`.
- Jobs execute **Calendar → Notion → Gmail**, no bulk applicant outreach.
- Calendar uses a SHA-256-derived deterministic event ID, independent Meet creation request, `sendUpdates=all` for the applicant plus lead and all shadowers, and a GET-before-POST idempotency check. Calendar may return a pending Meet URL; the worker retries GET for the same event and never generates a second event ID.
- Notion reads the page first, verifies campus, email, status, and reservation identity, and only patches interview-specific fields. If a student withdrew or the record belongs to a different booking, it does not overwrite.
- Gmail is only queued after Notion synchronization. A deterministic MIME Message-ID is used for traceability, but Gmail has no general idempotent send key: an ambiguous outcome is quarantined and **never blindly resent**.
- Expired processing leases go to `reconcile_required`. Operators must inspect the provider and database before considering a manual recovery.
- No cron route is enabled in this increment. The initial canary worker is administrator-triggered for controlled testing.

## Explicitly required server-side configuration before a controlled canary

The core feature controls must be reviewed and enabled only after approved release of the app code. The current production Vercel settings still have booking, outreach, Calendar writes, Gmail sends, Notion writes, and the outbox worker OFF.

Additional canary-only settings:

- `INTERVIEW_PRODUCTION_CANARY_ENABLED`
- `INTERVIEW_PRODUCTION_WORKER_ADAPTER_READY`: **must remain unset/false until provider grants and tests are completed**
- `INTERVIEW_PRODUCTION_CANARY_EMAILS`: exact dedicated Workspace test recipients, max five
- `INTERVIEW_PRODUCTION_CANARY_PAGE_IDS`: exact dedicated Notion test pages, max five
- `INTERVIEW_PRODUCTION_CALENDAR_READS_ENABLED`: live free/busy permissions
- `INTERVIEW_PRODUCTION_CALENDAR_INVITES_APPROVED`: separate permission before any Calendar invitations to live staff
- `INTERVIEW_PRODUCTION_CALENDAR_REFRESH_TOKEN`: authorized `interviews@campus2care.org`
- `INTERVIEW_PRODUCTION_GMAIL_REFRESH_TOKEN`: authorized `contact@campus2care.org`
- `INTERVIEW_NOTION_LIVE_TOKEN`: permission to the existing campus-specific applicant pipelines
- Google OAuth client ID/secret, production Neon URL and exact expected host, and protected staff authentication.

Store credentials only in protected Vercel environment settings, never in GitHub, a test file, Notion, or chat. The Vercel environment audit on October 29 found the three production provider tokens, the separate staff-invitation approval flag and the worker-readiness flag **not configured**.

## Safety sequence before GO

1. Reconcile the current default branch and keep the custom interview feature isolated from the public application and volunteer availability pages.
2. Verify a dedicated canary row exists in BU/BC with a matching approved test email. Do not modify a real applicant's record to simulate a canary.
3. Verify the three production service grants belong to the correct organization accounts, including Calendar and Gmail scopes, and verify all scheduled shadowers consent to any test invitation.
4. Conduct one controlled canary with an isolated test applicant: email verification, slot hold, Calendar + unique Meet with attendee list, Notion writeback, Gmail acceptance, and observable reconciliation status.
5. Test Calendar pending conference generation, provider timeouts, 429, Notion mismatch, and forced worker crash. A Gmail timeout must remain reconciliation-required until externally verified.
6. Test cancellation, rescheduling, status recovery, production heartbeat and rollback before expanding to live applicants.
7. Keep `INTERVIEW_OUTREACH_ENABLED=false` and `INTERVIEW_PRODUCTION_ENROLLMENT_ENABLED=false` until a fresh eligible-recipient review and explicit release approval.

**Known limitations:** The current worker is the **create/confirm** path; production cancellation, rescheduling, operational metrics and autonomous cron dispatch remain separate work. Its test suite uses mocked provider responses rather than genuine production API calls. No live deployment, credentials, test applicant enrollment or real canary has been completed.
