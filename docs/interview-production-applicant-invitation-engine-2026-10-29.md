# Production applicant campaigns: approval, queue, and Gmail delivery

**Release status: NO-GO.** This code is on a draft GitHub feature branch. No database migrations have been applied, no production Vercel deployments or environment flags changed, and no volunteer emails have been sent.

## Implemented behind independent gates

1. **Exact recipient manifest.** Only the founder account may submit a set of 1–50 named BU/BC page IDs, recipient HMACs and per-recipient manual-outreach evidence. The server re-scans both live Notion pipelines, checks current eligibility, duplicate emails, opt-outs, existing bookings, cross-campus identity and historical outreach, then returns a SHA-256 approval digest. Approval must repeat exactly the same source evidence and digest. The 24-hour manifest is a frozen exact-recipient allowlist, not permission to email anyone else.
2. **Transactional queue.** The production scheduler checks the Friday 2 PM, Sunday 5 PM and Monday 9 AM ET run keys. Only an unexpired, founder-approved manifest can queue. Every candidate is rechecked by Notion, booking eligibility, confirmed interviewer-team capacity and recipient-hash locking. Invitation token hashes, applicant contact, outreach attempt, encrypted message payload and Gmail outbox job are committed atomically. Overlapping scheduler runs cannot silently enroll the same recipient twice.
3. **Dedicated Gmail sender.** The sender checks active consent, live Notion status, reservations, opt-outs, previous communications, 48-hour spacing and the maximum of two routine messages per rolling seven days. The invitation link stores the encrypted secret in the fragment, not the server request URL. Gmail sends from the Workspace account contact@campus2care.org. The message enters a non-retryable uncertainty state before any external Gmail I/O; crashes and ambiguous sends require manual reconciliation, never automatic resend.
4. **Scheduler wiring.** Due campaign checks and the invitation outbox worker are invoked only with the full production-real booking gate AND both INTERVIEW_PRODUCTION_APPLICANT_CAMPAIGNS_ENABLED=true and INTERVIEW_REAL_APPLICANT_SENDS_APPROVED=true. If disabled or lacking a valid manifest, the scheduler reports blocked or needs_attention.

## Founder approval API

POST /api/interview/admin/production-applicant-approval (founder-only, same-origin JSON):
- action=preview: validate exact recipients, manual evidence and current source data. Return approvalDigest, campus counts, and canSend=false.
- action=approve: send the same recipients and approvalDigest. Requires INTERVIEW_PRODUCTION_APPLICANT_APPROVAL_ENABLED=true and separate audience-review flag. Creates a single immutable manifest and refuses conflicting approvals. Returns canSend=false; no token issuance or Gmail call.

The API is not an invitation/sending API. Approval is never sufficient by itself to activate the sender.

## Required before production launch

- Review and apply migration db/interviews/015_production_applicant_campaign.sql to the intended database only, with backups and an explicit migration review.
- Validate the founder's manual outreach evidence and source-ledger reconciliation for each recipient. Never auto-mark absent Neon history as clean.
- Rehearse actual Calendar/Meet availability for an approved 20-minute lead/shadower team; preliminary capacity is not the same as external Calendar free-busy.
- Test transaction rollback, concurrent queue calls, mid-send opt-out, invitation verification, canceled bookings, expired approval and unknown Gmail acceptance. Add operator-facing reconciliation tooling and stale lease alerts.
- Verify that approval runs are scheduled within 24 hours of their Friday/Sunday/Monday send; otherwise campaigns remain blocked.
- Confirm the independent GitHub CI and Vercel build from the exact PR head, and investigate any build-rate-limit statuses.
- Explicitly approve rollout in a separate founder release check. Do not flip production flags, merge main or send real communications as part of this draft.

## Monitoring

Heartbeat must expose applicantQueued, applicantSkipped, applicantWorker and blockedDispatchKinds, without applicant personal data. The Gmail API accepted ID is recorded separately from actual inbox delivery, which cannot be assumed.

**Current deployment:** public campus2care.org remains on main. This PR only stages implementation; zero real sends have been made.
