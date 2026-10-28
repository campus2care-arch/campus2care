# Campus2Care Interview Scheduling Portal
**Implementation blueprint | 28 October 2026 | Phase 1: foundations only**

## Release rules
- Existing live website, application form, availability form, submission receipt/recovery, and BU/BC Notion pipelines must continue to work unchanged.
- Do not merge or promote this work without green tests, preview verification, a private staging dry run, and explicit production approval.
- Default flags: `INTERVIEW_BOOKING_ENABLED=false`, `INTERVIEW_OUTREACH_ENABLED=false`, `INTERVIEW_CALENDAR_WRITES_ENABLED=false`.
- **No real applicant email, real calendar event, or production Notion mutation in this initial branch.** Synthetic testing only; preview must not be able to reach production Notion or production email audiences.
- The current `/availability` page concerns *volunteer placement* availability and is unrelated to **EA interview availability**. Do not reuse or overwrite those records.
- `interviews@campus2care.org` is the organization-controlled Calendar/Meet owner. `contact@campus2care.org` sends branded applicant and EA emails. `president@campus2care.org` administers the system.

## Experience and access

**EA page:** `/interview/staff/availability`. Workspace-only Google sign-in, or a short-lived signed invitation link followed by identity verification. No EA Calendar OAuth grant is required merely to edit availability. Sign-in establishes EA identity, not Google Calendar data permission. A server-side allowlist, not an email-domain check alone, authorizes staff. Each EA sees only their own upcoming weekly records and recurring template.

**Leadership page:** `/interview/admin`. Require server-enforced leadership roles (president and delegated coordinator/Emily); filter by campus and EA, show actual weekly confirmation responses, available vs booked slots, unmatched applicants, reminders, and sync failures. Never expose that dashboard publicly or depend on client-side filters for security.

**Applicant page:** `/interview` with an opaque, expiring invitation token tied to an existing Notion volunteer record, campus and recipient identity. Applicants need no Workspace login; require email verification before final booking. Show available appointment times only. Never reveal EA personal calendar details or other students' names.

Do not share the master calendar broadly to applicants. EAs are invited to their specific events. Their `Executive Associate Owner` caseload field remains distinct from `Interviewed By`, which is set at booking.

## Weekly EA availability: exact lifecycle

- All times use `America/New_York`; week is **Monday through Sunday**, week key is local Monday `YYYY-MM-DD`.
- Each EA stores a reusable, user-editable **recurring weekly template**, with zero or more windows per day. Support multiple windows each day (e.g. Monday 2–4 PM and 6–7 PM), 5-minute input resolution, and explicit unavailable days.
- **Wednesday 3 PM ET:** email active EAs a private link to next week's availability. Prefill from their saved recurring template plus any next-week overrides; label it *not yet confirmed*.
- **Thursday 6 PM ET:** remind only EAs who have not confirmed or explicitly marked themselves unavailable.
- **Friday 11 AM ET:** notify Emily/president of missing confirmations and projected interview capacity. Do not automatically publish slots for nonresponders.
- Every EA selects either **Confirm these hours** or **No interview availability this week**. Either counts as a completed response in the leadership dashboard. A template carried forward without confirmation is *not* eligible for bookings.
- Confirmed week records store `eaId`, `weekStart`, `confirmedAt`, effective windows, and edit history. Leadership sees *confirmed / unavailable / pending / missing*, last action, total hours, bookable slots, and assignments. Treat no-response differently from confirmed zero hours.
- EA may amend their confirmed week at any time. Updates affect only **unbooked** slots. Existing booked events are never silently removed or moved; flag new conflicts for rescheduling/reassignment.
- If a day becomes unavailable, the EA chooses an explicit date exception, not a permanent edit to the weekly template; permanent template edits affect future prefilled weeks but do not retroactively override already confirmed bookings.
- Personnel are driven by an active interviewer roster with name, Workspace email, campuses allowed, roles, enabled/disabled and capacity limits. Initial roster may use current active EAs (Allie, Emily, Cori, Edla, Barthina, Sierra, Zaha, Sarah, Cayla, Hannah) after an identity audit; do not assume the list is permanent or that every EA interviews both campuses.
- On departure/suspension, stop new slots immediately and surface existing appointments for human reassignment; preserve history. Do not delete past calendar events or applicant records.

## Applicant outreach engine: three weekly evaluation runs, not three emails per person

- **Friday 2 PM ET:** first invitation run after availability review for the following Monday-Sunday week.
- **Sunday 5 PM ET:** process newly eligible applicants and overdue unscheduled applicants who are due for a reminder.
- **Monday 9 AM ET:** process newly eligible applicants and people due for a permitted reminder. Monday's run must not resend Sunday's email.
- Enforce **at least 48 hours** between routine applicant messages and **no more than two** invitation/reminder emails to a person per rolling seven days. Each execution is an eligibility check, not a mandatory email to everyone.
- Read the BU and BC Notion pipeline databases independently, retaining their separate identities and school routing. Preserve `Other` university routing to BU and original entered school. Verify exact status names, relevant opt-out properties, interview date fields and historical interview notes before launching: don't hard-code unverified property names.
- Eligible applicants: approved-to-invite stage, valid verified email, no confirmed booking, no recorded completed interview, no withdrawal/decline/opt-out/paused flag, and not already in a pending manual outreach state. A lack of Notion update alone must never make an already-booked applicant eligible.
- Do not send invitations if no confirmed future capacity exists for their allowed campus. Audit every run with reasons for send/skip (without logging applicant personal data).
- Send with authorized `contact@campus2care.org` Gmail identity, preserving existing delegated inbox and label workflows. Distinguish Gmail drafts, queued jobs, attempted sends, accepted sends, failures and suppressions. Calendar invitation messages are separate from branded invitation emails; do not double-send duplicate confirmations.
- Email confirmations and cancellation notices should be event-triggered, not restricted to Friday/Sunday/Monday campaign days.
- Enrollment emails should clearly show the school, interview length, time zone, cancellation/rescheduling link, and that the interview occurs by Google Meet.

## Booking and Calendar rules

1. Student loads personalized link; resolve opaque token to eligible applicant record and its campus. Show pooled slots from only active, confirmed interviewers eligible for that campus. Never show exact EA calendar details.
2. Generate candidate 20-minute slots with optional 5-minute buffer and day exceptions using `lib/interview-availability.ts`. Use per-EA confirmed interview bookings and, where calendar sharing is granted, EA free/busy blocks. Do **not** use all events on the master calendar to mark every EA busy: simultaneous interviews are valid.
3. On selection, recheck eligibility, authorization, fresh free/busy and booking state; acquire a transactionally enforced unique reservation for `eaId + startInstant` (and `applicantId` active booking). Store first, then create one 20-minute event in the `interviews@campus2care.org` primary calendar with assigned EA and applicant as attendees and an individual Google Meet link.
4. Sync exact event ID, organizer account, time, assigned interviewer and status to the appropriate campus's existing Notion record, without modifying EA caseload owner or unrelated volunteer availability fields.
5. Deliver branded confirmation and a cancellation/reschedule capability after Google returns a valid Meet link. Provisioning may be pending: retry event fetch before confirmation. On ambiguous Google/Notion create results, hold for reconciliation rather than duplicating.
6. Cancel/reschedule atomically in the scheduling database and reconcile Google event + Notion. Protect already confirmed appointments when an EA changes schedule; no silent cancellations.
7. Use unique Meet conference for each interview; keep links private. The team tested multi-account access with Open access and host-first disabled, but full co-host privileges are not guaranteed on the free Workspace for Nonprofits edition. Before launch, verify the EA and external guest can remain connected when `interviews@` is **not present at all**, and that policies for meeting interruptions are acceptable.
8. Google Workspace event guests are not co-hosts. Do not enable event guest editing merely to approximate host permission. No broad Calendar admin grants to interviewers.

## Technical data model (transactional database, separate from Notion)

- `interviewer`: immutable id, Workspace email, display name, active flag, allowed campus IDs, role, interview capacity.
- `interviewer_template`: versioned recurring windows; changing it never edits past confirmations.
- `interviewer_week`: immutable interviewer/week unique pair; confirmed status, timestamps, effective windows and exceptions, revision.
- `interview_reservation`: immutable id, campus, Notion record id, student email hash/reference, EA id, local date/time, UTC start/end, status, Google Calendar event id, Google Meet URL, original booking token hash, revision. Enforce unique active reservation per applicant and per EA/time. Google event ID must also be unique.
- `outreach_attempt`: idempotency key (campus, applicant id, campaign type, week/scheduled run), recipient reference, queued/sent/failed/suppressed outcome, Gmail message id, sent timestamp and retry status. Track per-recipient rolling limits across BU and BC.
- `availability_request`: EA/week/kind unique key, schedule/last email timestamps, signed-link hash, expiry, completion.
- `integration_outbox`: durable pending Google, Gmail and Notion operations with attempt count, next retry, terminal reconciliation required state, and external ids; transactional enqueue.
- `audit_event`: actor, action, object id, time, result and minimal metadata. Keep applicant names, email content and access tokens out of public logs and URLs.

A database must enforce reservation uniqueness. Vercel Blob and Notion are **not** substitutes for atomic, concurrent booking transactions. Use PostgreSQL (or an equivalent transactional store) and obtain approval for any paid plan or migration before enabling writes.

## Architecture and authentication

- Existing Next.js 16 Campus2Care repository remains the single web app. Add dedicated `/interview` paths without replacing or altering `/application`, `/availability`, their Notion routing or recovery logic.
- Organization-owned Google Cloud project managed through `president@` with Calendar API, Gmail API and optionally Meet API enabled.
- Calendar OAuth grant is restricted to `interviews@`; send-as Gmail authorization to `contact@` is separate. Do not assume Gmail delegation in a browser grants Gmail API authorization. Store secrets only in protected server environment configuration, never GitHub docs, client bundles or public Notion pages.
- Staff identity should be Google Workspace login with server-side role lookup; staff need not grant the app their personal calendars. Optional free/busy matching requires separate, deliberately granted read-only calendar sharing to `interviews@` and must fail conservatively when data are unavailable.
- Scheduled dispatchers may be Google Apps Script time-driven triggers authenticated to protected server endpoints if that fits the nonprofit's free-cost target, but account for imprecise trigger execution, limits and retries; do not publish endpoints without authorization. Do not assume Vercel free-tier cron supports all required weekly run times. A durable queue and job-level idempotency are mandatory regardless of trigger provider.
- Since daylight-saving time shifts, derive dispatch windows by `America/New_York` local date/time on the server and persist unique dispatch keys. Never hard-code an ET = UTC-4 or UTC-5 assumption.
- Preserve Vercel preview credentials isolation. Never configure preview with production Gmail sender, production calendar mutating scopes, live Notion write token or real applicant mailing list.

## Delivery phases and gates

1. **Foundation (this branch):** pure availability rules, test cases, documentation. No production side effects.
2. **Infrastructure:** select and provision transactional store; enroll Google Cloud client and validate account-scoped credentials; audit active EA roster, Notion status properties and linked applicant identifiers; configure separated staging.
3. **EA availability:** staff auth, persisted recurring templates, weekly exceptions and confirmations, zero-hours response, leadership readiness dashboard, audited reminder jobs. Dry-run emails to test accounts.
4. **Calendar booking:** private student links, pooled time selection, atomic reservation locks, Google event/Meet creation and independent EA access tests, cancellation/reschedule and conflict reconciliation.
5. **Notion and communications:** campus-isolated sync, Gmail sender with branded confirmation and invitation templates, Friday/Sunday/Monday policy engine, suppression and delivery logs, consent/opt-out handling.
6. **Pilot and release:** test double booking, DST, conflict changes, outgoing email caps, no-show/reschedule, EA offboarding, Notion 429/5xx, Gmail failure, Calendar pending conference, simulated crashes, and wrong-campus routing. Stage a production-target deployment without domain promotion; release only after written approval.

## Current repository baseline

As inspected on 2026-10-28, `main` is `be6077ad9aef041ea00e7bbd5bfa4fb9045ff4a6`. PR #21 restored durable BU/BC application and availability routing; later PRs for EA balancing and separate BC dashboards have been merged. Existing `vercel.json` already schedules submission receipt replay. Preserve its behavior and tokens.


## Phase 2: implemented staff portal (draft branch, NOT live)
- `/interview/staff/availability`: individual EA recurring template editor, multiple windows per day, per-week confirmation, week-specific exceptions, explicit no-availability response, conflict revision handling, sign-in/logout.
- `/interview/admin`: president/leadership-only readiness view by EA and upcoming week, explicit missing vs unavailable vs confirmed. Slot totals are **unadjusted preliminary capacity**, not confirmed booking availability.
- `/api/interview/auth/start`, `/callback`, `/logout`: Google Workspace sign-in with OAuth authorization-code + PKCE, verified Google ID-token signature and `hd=campus2care.org`, server-side email allowlist, short-lived HTTP-only signed session.
- `/api/interview/staff/availability`: authenticated EA read/write of their own default/week records only; origin checks, input validation and conditional ETag write support.
- `/api/interview/admin/readiness`: server-enforced leadership read of a configured roster only.
- `lib/interview-store.ts`: isolated private Blob namespace and distinct store token from application submission receipts. This is an **interim EA availability store only**, never a booking database.
- No Google Calendar booking write, Google Meet creation, Gmail send or Notion write is triggered by these pages. Those integrations remain out of scope until safe testing.

### Configuration checklist (administrators only; NEVER commit values to source control)
1. In Google Cloud Console, sign in with the organization's administrative identity `president@campus2care.org` and create or select an organization-owned Cloud project. Configure a Google Auth Platform consent screen restricted to **Internal** Workspace users (if the project belongs to the Workspace organization).
2. Create an OAuth 2.0 **Web application** client with authorized redirect URI `https://www.campus2care.org/api/interview/auth/callback`. Scope only `openid email profile` for this EA/staff sign-in; Calendar/Meet and Gmail application scopes belong to the separate backend service integrations later.
3. In Vercel's protected **production** environment settings, provide:
   - `INTERVIEW_GOOGLE_CLIENT_ID` and `INTERVIEW_GOOGLE_CLIENT_SECRET`
   - `INTERVIEW_BASE_URL=https://www.campus2care.org` (no trailing slash)
   - `INTERVIEW_AUTH_SECRET`: strong random secret, at least 32 characters, generated locally (do not send it in chat)
   - `INTERVIEW_ADMIN_EMAILS`: comma-separated specific leadership Workspace emails, including Emily when verified. The president account is authorized by code.
   - `INTERVIEW_EA_EMAILS`: comma-separated **actual** active EA Workspace addresses; do not guess addresses from first names. This controls both staff access and dashboard roster.
4. Provision an isolated **private Vercel Blob store** for interview staff availability data, not the existing application-recovery store. Assign its write credential as `INTERVIEW_BLOB_READ_WRITE_TOKEN` in the relevant protected environment. Keep this credential server-side.
5. Only after a controlled staging test, set `INTERVIEW_STAFF_ENABLED=true` in the intended environment. Missing credentials/flag make the endpoints fail closed. Keep `INTERVIEW_BOOKING_ENABLED=false`, `INTERVIEW_OUTREACH_ENABLED=false` and `INTERVIEW_CALENDAR_WRITES_ENABLED=false`.
6. For a preview test, use **a distinct preview OAuth client, base URL and private Blob store**, not production Gmail, Calendar, Notion or storage credentials. Configure each exact preview callback URI separately. Don't add any wildcard redirect URLs.
7. Validate the president can access the leadership route, an active EA can edit **only** their own availability, an unlisted Workspace user is denied, status persists after reloading, concurrent edits yield conflict instead of lost updates, and a missing week confirmation displays as incomplete.
8. Review and merge only after CI, private preview tests, and explicit deployment approval. A merged app without credentials will continue to fail closed, but should not be considered a functioning staff scheduler.

### Reminder dispatch and booking scope still pending
The Wednesday/Thursday EA availability emails, Friday escalation, Friday/Sunday/Monday applicant campaigns, Calendar/Meet creation, and automatic BU/BC Notion updates are **designed but not enabled or implemented in the current portal**. They require service account authorization, a durable scheduled job queue, verified Notion property mapping, and a transactional booking database. Do not interpret an EA confirming their available hours as a Google Calendar event or an applicant invitation.

### Preview infrastructure handoff (28 October 2026)
- Organization-owned Google Cloud project: `campus2care-interviews` (project number `126300957153`), administered by `president@campus2care.org` under `campus2care.org`.
- Internal Google Auth Platform app: **Campus2Care Interview Scheduling**. Separate web OAuth client: **Campus2Care Interviews Preview**. Identity scopes remain `openid email profile`; this does not authorize Calendar or Gmail operations.
- Exact preview origin: `https://campus2care-git-feature-inter-9dfe34-campus2care-archs-projects.vercel.app`. Its only OAuth callback is `/api/interview/auth/callback` on that origin.
- Private preview Blob store: **campus2care-interviews-preview**, `store_7zzOt7mgQot5xY7Z`, region `iad1`. Credentials use the `INTERVIEW_BLOB_` prefix and are scoped to `feature/interview-scheduling-foundation-20261028`, preview only. Production submission-recovery storage remains separate.
- Preview access roster: `bob@campus2care.org` as test EA; `president@campus2care.org` as administrator. Do not add real EAs until the controlled test passes and their identities and campuses are audited.
- OAuth client secret and session signing secret are stored as Vercel Secrets. Do not place their values in this document, PR comments, screenshots, or logs.
- Production has no interview configuration from this setup. Applicant outreach, Calendar writes, and booking remain disabled. Persisted EA availability is not a transactional reservation database.
- Storage reads now take the revision from the same response as the content. A separate metadata request could otherwise associate old content with a newer revision and allow lost updates.
- Staff and leadership week selectors include the current week so an EA can amend a confirmed week. CI includes both interview pages and API paths.
- Controlled deployed preview trial passed: Bob's Google sign-in; multi-window recurring-template save; rejection of overlapping windows; template prefill without auto-confirmation; week-specific exception persistence after reload; explicit unavailable response; stale second-tab save rejection; Bob denied leadership data; president leadership access and a separate empty personal schedule; missing vs unavailable readiness counts; sign-out.
- Synthetic trial state: Bob has 2.5 entered hours and five preliminary slots for `2026-11-02`; `2026-11-09` is explicitly unavailable with zero slots; `2026-11-16` has no weekly response. These records live only in the preview store. Remove Bob from the production roster before any pilot with actual staff.
- Google Calendar API and Gmail API are enabled in this Cloud project. This does **not** grant the application access to `interviews@` or `contact@`; the account-specific backend OAuth authorizations remain pending.
- Cost guard: the Google Cloud project has **no billing account linked**; the Vercel team remains **Hobby**. Do not add billing, start paid trials, upgrade plans, raise billable quotas, or activate a paid database without Andrew's explicit approval. Standard Calendar/Gmail usage is free within quota; review current quotas before launch. A transactional booking database has not been provisioned.
