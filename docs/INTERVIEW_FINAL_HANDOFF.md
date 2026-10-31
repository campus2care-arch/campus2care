# Campus2Care Interview System — Minimal-Credit Final Handoff

**Owner goal:** Complete rollout without purchasing Vercel Pro or spending additional coding-agent credits on rediscovery. One PR chain, one audited preview deployment, one controlled pilot, no mass emails.

**Current architecture:** Next.js web app on Vercel Hobby; Neon Postgres for booking/outbox; separate BU and BC Notion pipelines; interviews@campus2care.org Calendar/Google Meet; contact@campus2care.org Gmail; external hourly Cloudflare Worker (configuration created in repo, not deployed). Scheduling: EA Wednesday 3 PM, Thursday 6 PM, leadership Friday 11 AM; applicant invitations Friday 2 PM, Sunday 5 PM, Monday 9 AM Eastern. Two contacts maximum per rolling seven days, 48h spacing; 20-minute team slots.

## Verified work completed

- Draft GitHub PR chain (merge in dependency order): #28 foundation -> #29 staff escalation -> #30 exact audience review -> #31 invitation engine and founder dashboard. Latest branch: `feat/interview-production-invitation-engine-20261029`.
- Founder-only /interview/admin review: candidate selection separated BU/BC, historical outreach notes, signed manifest preview, approval, monitoring and safe cancellation of untouched batches.
- Transactional recipient lock, invitation token hash, AES-GCM encrypted outbox payload, delivery quarantine, opt-out/booking suppression, weekly capacity checks, future approved booking weeks, Google free/busy check.
- Public booking email link uses URL fragment and the browser removes it from history. Verified booking client reads fragment token.
- Authenticated production POST/GET `/api/interview/production/scheduler`, with non-2xx only on actual processing failures; business blocks remain visible in successful heartbeat body.
- Cloudflare hourly scheduled Worker sources: `infra/interview-cron/worker.mjs`, `infra/interview-cron/wrangler.toml`. Disabled by default (`INTERVIEW_CRON_ENABLED=false`).
- Additive campaign migration `db/interviews/015_production_applicant_campaign.sql` applied **only** to isolated Neon branch `br-steep-tooth-b8x1b5gz` (`interview-staging-20261028`); campaign tables verified empty. Production Neon branch `br-withered-wave-b8zxywxa` has NOT been migrated.
- Staging-only schema parity migration `db/interviews/016_staging_suppression_parity.sql` applied only to staging because its older snapshot lacked the recipient_suppression table. Main Neon already has the suppression table and correct real-email format constraint. Never import production applicant hashes to staging.
- GitHub Actions contains tests, lint, TypeScript and Next production build for each branch update. Confirm **the latest HEAD** passes rather than relying on a prior run.
- Public production domain remains on original main commit unless independently verified otherwise. No real applicant Gmail sends or release flags enabled by this work.

## Only remaining release work (in strict order)

1. **Finish the last CI check and perform a static security pass.** Confirm #31 latest HEAD tests/lint/typecheck/build. Revalidate SQL columns and DB constraints with read-only EXPLAIN on staging, including production campaign Gmail worker. Confirm all contract env vars, especially `INTERVIEW_BASE_URL`, `INTERVIEW_TOKEN_ENCRYPTION_KEY` (32-byte base64), `INTERVIEW_AUTH_SECRET`, `INTERVIEW_NOTION_LIVE_TOKEN`. NEVER output secret values.
2. **One preview deployment when Vercel quota allows.** Deploy the *exact* approved commit as Preview, not Production. Validate the inert founder UI, synthetic BU/BC records, email-verified booking, Google Calendar+Meet and Notion updates with explicitly authorized test aliases only. Do not merge to main before preview proves behavior.
3. **Set up free Cloudflare Worker.** Deploy `infra/interview-cron` to a Cloudflare account. Store `SCHEDULER_SECRET` with Wrangler's secret store, matching production `INTERVIEW_PRODUCTION_SCHEDULER_SECRET`. Keep `INTERVIEW_CRON_ENABLED=false` until live booking is verified and founder signs off. Cron `0 * * * *` intentionally hourly; server evaluates Eastern Time and DB guards idempotency. Do not remove the existing Vercel submissions-replay cron.
4. **Reconcile real prior outreach.** Founder must review historical `contact@campus2care.org` AND `campus2care@gmail.com` (and delegated history), including withdrawals/opt-outs/manual interview invites. Record evidence for each selected real recipient in the approval UI. Never auto-clear Gmail history from missing Neon attempts. First pilot should contain ~5 consenting applicants with approved 20-minute team capacity.
5. **Production migration and rollout.** Back up production Neon and review/add `015_production_applicant_campaign.sql`; do NOT apply staging-only `016` to production. Resolve PR dependency chain and confirm exact released SHA. Configure production service integrations and independent flags only after the founder explicitly approves launch. Do not enable all flags at once.
6. **Pilot and observe.** Verify Gmail acceptance *and actual delivery*, recipient OTP, Calendar event with lead and shadower, Google Meet, correct Notion BU/BC row, no duplicate resend, cancellation/rescheduling, and queue reconciliation. Only then enable Cloudflare cron and expand the batch. On uncertain Gmail sends, pause and reconcile, never automatically resend.

## Operational red flags / hard stops

- Do not claim “production launched” merely because GitHub CI passed.
- Do not assume Vercel Hobby's once-daily cron can execute six time-specific schedules. Use Cloudflare for the hourly heartbeat.
- No real applicant in staging, no production switch changes without explicit founder permission, and no real applicant mail without exact batch approval.
- Do not rerun a Gmail send after any timeout or uncertain response; the queue tracks `reconcile_required` and intentionally quarantines leases.
- If provider authorization or database migration is missing, keep the service disabled and report the exact missing item.

## One copy-ready instruction for Work / Claude Code

“Continue Campus2Care's interview rollout from PR #31 and `docs/INTERVIEW_FINAL_HANDOFF.md`. Do not rebuild finished work. Use connected GitHub/Vercel/Neon; read the current PR chain and latest HEAD. Spend as few steps/credits as possible: validate the exact CI HEAD, perform one preview after quota availability, run authorized isolated end-to-end Gmail/Calendar/Notion tests, deploy the configured Cloudflare hourly worker **disabled** with secret stored outside code, and return a concise release GO/NO-GO checklist. Production database, main branch, flags, and real recipients must remain unchanged until explicit founder approval. If a hard blocker remains, fix only that blocker and leave a precise action list. Never enable real applicant sends without approval.”
