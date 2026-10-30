# Production applicant campaigns: approval, queue, and Gmail delivery

**Release status: NO-GO.** This code is on a draft GitHub feature branch. The additive campaign migration has been applied ONLY to isolated Neon branch `interview-staging-20261028`, verified empty. No production database migrations, Vercel production deployments or environment flags changed. No volunteer emails have been sent.

## Implemented behind independent gates

1. **Exact recipient manifest.** Only the founder account may submit a set of 1–50 named BU/BC page IDs, recipient HMACs and per-recipient manual-outreach evidence. The server re-scans both live Notion pipelines, checks current eligibility, duplicate emails, opt-outs, existing bookings, cross-campus identity and historical outreach, then returns a SHA-256 approval digest. Approval must repeat exactly the same source evidence and digest. The 24-hour manifest is a frozen exact-recipient allowlist, not permission to email anyone else.
2. **Transactional queue.** The production scheduler checks the Friday 2 PM, Sunday 5 PM and Monday 9 AM ET run keys. Only an unexpired, founder-approved manifest can queue. Every candidate is rechecked by Notion, booking eligibility, confirmed interviewer-team capacity and recipient-hash locking. Invitation token hashes, applicant contact, outreach attempt, encrypted message payload and Gmail outbox job are committed atomically. Overlapping scheduler runs cannot silently enroll the same recipient twice.
3. **Dedicated Gmail sender.** The sender checks active consent, live Notion status, reservations, opt-outs, previous communications, 48-hour spacing and the maximum of two routine messages per rolling seven days. The invitation link stores the encrypted secret in the fragment, not the server request URL. Gmail sends from the Workspace account contact@campus2care.org. The message enters a non-retryable uncertainty state before any external Gmail I/O; crashes and ambiguous sends require manual reconciliation, never automatic resend.
4. **Scheduler wiring.** Due campaign checks and the invitation outbox worker are invoked only with the full production-real booking gate AND both INTERVIEW_PRODUCTION_APPLICANT_CAMPAIGNS_ENABLED=true and INTERVIEW_REAL_APPLICANT_SENDS_APPROVED=true. If disabled or lacking a valid manifest, the scheduler reports blocked or needs_attention.

## Founder approval API

POST /api/interview/admin/production-applicant-approval (founder-only, same-origin JSON):
- action=candidates: show the authorized founder the specific Notion page, campus, email and recipient HMAC for possible invitations, with manual historical-outreach reconciliation marked required. The existing general preflight stays aggregate-only. This endpoint is never for general staff.
- action=preview: validate exact recipients, manual evidence and current source data. Return approvalDigest, campus counts, and canSend=false.
- action=approve: send the same recipients and approvalDigest. Requires INTERVIEW_PRODUCTION_APPLICANT_APPROVAL_ENABLED=true and separate audience-review flag. Creates a single immutable manifest and refuses conflicting approvals. Returns canSend=false; no token issuance or Gmail call.

The API is not an invitation/sending API. Approval is never sufficient by itself to activate the sender.

## Required before production launch

- The additive migration `db/interviews/015_production_applicant_campaign.sql` is verified on the isolated Neon staging branch; review and apply independently to the production database only as part of an approved release.
- Validate the founder's manual outreach evidence and source-ledger reconciliation for each recipient. Never auto-mark absent Neon history as clean.
- Rehearse actual Calendar/Meet availability for an approved 20-minute lead/shadower team; preliminary capacity is not the same as external Calendar free-busy.
- Test transaction rollback, concurrent queue calls, mid-send opt-out, invitation verification, canceled bookings, expired approval and unknown Gmail acceptance. Add operator-facing reconciliation tooling and stale lease alerts.
- Verify that approval runs are scheduled within 24 hours of their Friday/Sunday/Monday send; otherwise campaigns remain blocked.
- Confirm the independent GitHub CI and Vercel build from the exact PR head, and investigate any build-rate-limit statuses.
- Explicitly approve rollout in a separate founder release check. Do not flip production flags, merge main or send real communications as part of this draft.

## Monitoring

Heartbeat must expose applicantQueued, applicantSkipped, applicantWorker and blockedDispatchKinds, without applicant personal data. The Gmail API accepted ID is recorded separately from actual inbox delivery, which cannot be assumed.

**Current deployment:** public campus2care.org remains on main. This PR only stages implementation; zero real sends have been made.

## External scheduling on Vercel Hobby

An authenticated, zero-payload POST endpoint is implemented at /api/interview/production/scheduler. It uses the existing production-only release gate AND the constant-time bearer verification against INTERVIEW_PRODUCTION_SCHEDULER_SECRET. GET returns limited, authorized status without processing jobs. Preview deployments are denied.

The Cloudflare Worker source is at infra/interview-cron/worker.mjs with infra/interview-cron/wrangler.toml. It uses one hourly cron (0 * * * *) and evaluates schedules on the Vercel server using America/New_York; one cron covers Friday 2 PM, Sunday 5 PM, Monday 9 AM and the EA Wednesday/Thursday/Friday windows while respecting EST/EDT changes. Recurring scheduler calls are protected by campaign run keys, per-recipient locking, and no-retry Gmail state.

Default INTERVIEW_CRON_ENABLED=false. SCHEDULER_SECRET must be provisioned as a Cloudflare secret, matching the server-side INTERVIEW_PRODUCTION_SCHEDULER_SECRET. Neither value belongs in GitHub or this document. An active production release must separately enable:
- all INTERVIEW_LIVE_RELEASE_APPROVED/INTERVIEW_LIVE_APPLICANTS_ENABLED and production booking/provider gates;
- INTERVIEW_PRODUCTION_SCHEDULER_ENABLED=true;
- INTERVIEW_PRODUCTION_APPLICANT_CAMPAIGNS_ENABLED=true;
- INTERVIEW_REAL_APPLICANT_SENDS_APPROVED=true;
- INTERVIEW_CRON_ENABLED=true in the independently deployed Cloudflare Worker.

**Never enable those as one bulk step.** First verify deployment, integrations, capacity, founder-approved recipients and the exact batch. Do not use Vercel Hobby Cron as a precise hourly substitute; its existing once-daily submissions replay job is left untouched.

## Staging work and fixes

- Neon staging branch ID: br-steep-tooth-b8x1b5gz. Tables installed and verified empty. Production primary remains untouched.
- Future live interview weeks are now accepted up to 40 days ahead, with week-specific capacity counts. The canary Nov 2 week remains protected.
- Invitation emails have a clickable, branded booking link. Google acceptance is still not proof of inbox delivery.
- Abandoned Gmail worker leases are quarantined for manual review rather than silently retried.
- Inactive EA accounts are excluded from reminder selection and delivery.
- Founder can cancel only an entirely unsent, unqueued approved batch. Once queued, cancellation is intentionally blocked pending manual recovery.
- Actual Google Calendar / Gmail / Notion provider-integration rehearsals, production schema migration, Cloudflare account deployment, and a Vercel preview of the latest SHA remain release blockers.

## Release operator checklist

1. Inspect draft PR #31 and its dependent draft PRs (#30, #29, #28). Resolve merge-order conflicts and require passing CI for the exact final commit.
2. After Vercel's Hobby deployment quota resets, create a *preview* for that exact SHA, verify founder UI in inert preview mode, and test synthetic bookings and no-output sends.
3. Confirm all real BU/BC pipeline schema, staff lead/shadower availability, Google Calendar and Meet, verified test Gmail accounts, and Notion sync. Do not use test accounts resembling real applicants without consent.
4. Review historical contact@campus2care.org AND legacy campus2care@gmail.com correspondence; record manual evidence for every exact recipient. Founder-approved manifest is per run, limited to 50 and expires within 24 hours. Do not use this to bypass existing opt-outs.
5. Provision the production migration after backups and release approval. Deploy Cloudflare Worker with INTERVIEW_CRON_ENABLED=false and a secret stored only in Cloudflare; verify it returns no requests until enabled.
6. Reconcile uncertain sends and prior bookings before enabling any live flags. Enable only the minimum independently approved flags and run one 5-person pilot; confirm Calendar, Notion, deliverability and rollback readiness.
7. Expand gradually only after the pilot is verified. Hourly scheduler monitoring and manual reconciliation remain operational obligations.
