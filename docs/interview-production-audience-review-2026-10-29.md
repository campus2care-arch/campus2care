# Production applicant invitation engine: audience review phase

**Status:** Staging-only code, no production promotion. This increment implements a bounded, independently reviewable audience preflight, **not** live applicant sends.

## What was added
- Production-only, opt-in Notion scanner for both live BU and BC pipelines. It verifies every page parent against the immutable campus database ID, checks all paginated records, and fails closed for rate limiting, invalid pages, or truncated scans.
- Deterministic audience evaluator using verified Notion Stage, Next Step, Workflow Status, Interview Status, Interview Date and Scheduling Reservation ID fields.
- HMAC deduplication across campuses, existing active/completed reservations, recorded opt-outs, recipient suppression, and outreach history. Findings use recipient HMACs and aggregate reasons, not raw addresses.
- Preliminary capacity check from future president-approved slots and active leads. This is **not** proof of Calendar free/busy or final bookability.
- Founder-only GET endpoint at /api/interview/admin/production-applicant-review. Opt-in flag: INTERVIEW_PRODUCTION_APPLICANT_REVIEW_ENABLED=true in a production-configured environment. Default is disabled.

## Read-only safety rules
- Never change main, production domains, credentials, or outreach flags for a scan. This code is only on a draft feature branch.
- Scanner does not issue invitation tokens, enroll applicants, write to Notion or Neon, or call Gmail.
- HTTP response has only aggregate reason counts and a SHA-256 manifest fingerprint, never raw names, emails, page IDs or HMACs.
- manualOutreachReconciled and canSend are always false. All otherwise eligible recipients are held as manual_outreach_not_reconciled because historic Gmail/manual communications may not be in Neon.
- Missing or uncertain status does not become eligible. Bad parent and pagination fail closed.
- Preview cannot read live records even if the flag is added there.
- Do not store actual applicant data in preview. Tests use invented identities and mocked Notion responses.

## Next phase (NOT implemented by this increment)
1. Reconcile manual Gmail outreach into reviewed suppression records with source evidence, including explicit approvals for an exact recipient set.
2. Generate bounded, server-stored, expiring, versioned recipient manifest with founder sign-off matching the SHA.
3. Before queuing, refresh every page's campus/email/status, opt-out, historic messages, booking state, 48-hour spacing, 7-day cap and actual interview-team availability.
4. Issue tokens and durable invitation/outreach/message/outbox records with recipient advisory locks and replay guarantees; never overwrite active tokens or existing bookings.
5. Add a Gmail invitation worker that rechecks eligibility directly before send and quarantines ambiguous sends for manual reconciliation.
6. Wire Friday 2 PM, Sunday 5 PM, Monday 9 AM Eastern campaigns into the production scheduler only after exact-recipient authorization and isolated end-to-end tests.
7. Validate BU/BC isolation, manual-send suppression, concurrency, opt-outs, and 20-minute booking capacity.

The production scheduler must continue reporting applicant campaigns as UNIMPLEMENTED. This preflight does not mean they are healthy.
