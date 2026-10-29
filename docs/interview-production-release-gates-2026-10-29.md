# Campus2Care Interview Production Release Gates
**Evidence snapshot: October 29, 2026 (America/New_York).**
**Status: NO-GO for real-applicant email or real booking.** This is an audit snapshot, not an authorization to flip feature flags. Repeat all dynamic checks on the day of release.

## Directly verified
- Latest inspected scheduling PR: #28 (draft, unmerged). Main branch does not contain `app/interview/page.tsx`. Preview build READY.
- The production Vercel environment has all of these flags set to `false`: `INTERVIEW_PRODUCTION_ENABLED`, `INTERVIEW_BOOKING_ENABLED`, `INTERVIEW_OUTREACH_ENABLED`, `INTERVIEW_CALENDAR_WRITES_ENABLED`, `INTERVIEW_GMAIL_SENDS_ENABLED`, `INTERVIEW_OUTBOX_WORKER_ENABLED`, and `INTERVIEW_PRODUCTION_ENROLLMENT_ENABLED`.
- `lib/interview-db.ts` explicitly throws `interview_database_production_disabled` under `VERCEL_ENV=production`; `requireInterviewStagingBooking` accepts preview only. Do not simply set the flags to true and assume it works.
- The production Neon database branch contains 53 `interview.schedule_slot` records; no recorded invitations, real bookings, or outreach attempts. The isolated staging branch contains the same 53 founder-managed November 2–8 shifts (31 BU, 22 BC) with 111 lead/shadow participant assignments.
- A staging conflict audit reported all eight participant calendars readable and zero schedule conflicts; separate slot-claim tests reported simultaneous leads accepted and shadow overlap rejected. This **does not** replace a live booking canary.
- The staging founder launch snapshot reviewed 232 live BU/BC applicant records: 64 candidates, 59 tentatively eligible and five suppressed, including three 48-hour spacing exclusions and two previously processed applicants. Candidate status and opt-outs must be recalculated before any real send. Snapshot was blocked; zero real Gmail invitation IDs.
- Only a manual staging scheduler heartbeat was evidenced in the audit. Installing the GitHub workflow on default branch is not proof of recurring autonomous execution.

## Live Notion schema verified directly (not an outstanding missing-field problem)
The canonical pipelines are:
- BU: `03192649741442fe86acdddcc7320798`, data source `collection://2a3fd7a6-1dcc-4b57-b394-0f8821b3a2c7`
- BC: `bc8eaec9a5d449cd87426e8613299a93`, data source `collection://c62767c6-3b89-4f45-82d5-9b8a17eb71ee`

**Both existing live sources already have**:
- `Interview Date` (date)
- `Interview Status` (select with `Not Scheduled`, `Scheduled`, `Completed`, `Missed 1st Interview`, `Didn't sign up`)
- `Interviewed By` (rich text)
- `Google Meet URL` (URL)
- `Scheduling Reservation ID` (rich text)

Do **not** recreate these columns. The prior blocked launch-review text asserting these three missing columns is outdated; the source-of-truth schema inspection supersedes that one blocker. The code contract `lib/interview-notion-contract.ts` was corrected and given a regression test.
The BU `Workflow Status` contains `Interview Scheduled`; BC `Workflow Status` **does not**. Retain the existing campus-specific mapping. Preserve `Executive Associate Owner`, placement availability, historical notes, and applicant intake fields.

## Remaining release work in order
1. **Production integration architecture**: Add production-specific, strictly gated DB client and booking/service paths. Never loosen `preview` synthetic-only protections to enable live sends. Separate real and synthetic credentials, recipients, and stores. Implement a *single* canary allowlist for verified test identities before general availability.
2. **Controlled code promotion**: Review PR #28 against the current live main (website application, `/availability`, BU/BC routing and submission recovery). Resolve merge conflicts and perform an explicit rollback-ready deployment. Test `https://www.campus2care.org/interview` loads without exposing staging tokens or accepting unapproved bookings.
3. **Production provider accounts**: Verify Calendar OAuth belongs to `interviews@campus2care.org` and Gmail sender is authorized as `contact@campus2care.org`; do not assume browser delegation grants Gmail API permission. Unique Meet conferences, attendee invites, 20-minute scheduling and shadow participants need real canary proof. Do not create unrelated Google calendar grants for EAs.
4. **Notion live field sync**: Run a read-only schema preflight on both sources; test a controlled synthetic/canary row and rollback. On confirmed booking update only mapped interview fields (and BU workflow where valid); do not change EA caseload owner, notes, availability, stage or applications.
5. **Transactional booking canary**: With an explicitly approved canary address, verify email verification, hold, single Calendar event, unique Meet link, lead plus shadow attendees, branded Gmail confirmation, correct campus Notion write, cancellation, reschedule, duplicate request reconciliation and no orphaned jobs. Test two leads at same time and shadow overlap denial. Clean up canary artifacts without touching real appointments.
6. **Scheduler heartbeat**: Prove repeated autonomous executions from the installed workflow. Validate no silent skipped runs, GMT/ET DST conversion, unique dispatch keys, retries and alerts; test Wednesday 3 PM, Thursday 6 PM, Friday 11 AM EA notifications, plus Friday 2 PM, Sunday 5 PM and Monday 9 AM applicant assessments with rolling send caps.
7. **Applicant launch**: Repeat eligibility against both live pipelines and legacy email/booking sources, opt-outs, 48-hour spacing and 2-per-rolling-7-days. Produce an approved send manifest with exact counts and final booking link. Keep campaign switches OFF until the canary passes and authorized release. Never send a live invitation to the currently nonexistent production booking page.

## Safeguards
- November 2–8 is **founder-approved**, not personally confirmed by each EA. Import only exact shifts already supplied, with back-to-back 20-minute slots and no additional five-minute gaps for this week.
- Only Andrew (BC), Cori (BU), Sophia (BU) are interview leads in that week's slot data. Ryan, Sarah, Zaha, Hannah and Cayla are shadow participants in designated slots, not independent bookable capacity. Bob is a synthetic test user and must never be selected for real applicants.
- Changes to recurring templates must not rewrite founder-approved shifts or existing booked appointments.
- No subscription upgrade, actual applicant blast, or broad production promotion based solely on unit tests.
- To mark GO, capture evidence of: live route, live canary, DB atomicity, Calendar & Gmail account ownership, BU and BC writeback, cancellation and rescheduling, autonomous scheduler heartbeats, current send manifest, rollback, and explicit campaign authorization.
