import { createHash } from "node:crypto";
import { googleProviderAccessToken } from "./interview-google-provider-auth";
import { confirmedInterviewNotionProperties, assertCampusPipelineParent } from "./interview-notion-contract";
import { renderInterviewMessage } from "./interview-email";
import { productionVerificationCanaryConfig, productionVerificationCanaryDatabase, assertProductionVerificationIdentity } from "./interview-production-verification-gate";
import { verifyLiveCanaryApplicant } from "./interview-production-notion";

const ID = "c2c-bu-booking-canary-20261029";
const PAGE = "408d6c55a9de81da9063fe9a32d88d9b";
const RECIPIENT = "contact+interview-canary-bu@campus2care.org";
const START = "2026-11-09T19:00:00.000Z"; // Nov 9, 2 PM EST: outside Nov 2-8 founder slots.
const END = "2026-11-09T19:20:00.000Z";
const RESERVATION_ID = "c2c00000-0000-4000-8000-000020261029";
const EVENT_ID = "c2cbucanary" + createHash("sha256").update(ID).digest("hex").slice(0, 42);
const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const NOTION = "https://api.notion.com/v1/pages/" + PAGE;
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
type Ledger = { id: string; state: string; calendar_event_id: string | null;
  meet_url: string | null; gmail_message_id: string | null; email_attempted_at: Date | null };

export class BookingProviderCanaryError extends Error {
  constructor(public readonly code: string, public readonly status = 409) {
    super(code); this.name = "BookingProviderCanaryError";
  }
}

export function bookingProviderCanaryConfig(env: Record<string, string | undefined> = process.env) {
  // Unlike the real booking flow, this gate REQUIRES all its write flags OFF.
  productionVerificationCanaryConfig(env);
  if (env.INTERVIEW_BOOKING_PROVIDER_CANARY_ENABLED !== "true") {
    throw new BookingProviderCanaryError("booking_provider_canary_disabled", 404);
  }
  if (env.INTERVIEW_BOOKING_PROVIDER_CANARY_EMAIL_APPROVED !== "true") {
    throw new BookingProviderCanaryError("booking_provider_canary_email_not_approved", 403);
  }
  if ((env.INTERVIEW_NOTION_LIVE_TOKEN ?? "").length < 20) {
    throw new BookingProviderCanaryError("booking_provider_notion_not_configured", 503);
  }
  return { id: ID, pageId: PAGE, recipient: RECIPIENT, start: START, end: END };
}

function normalize(v: unknown) {
  return typeof v === "string" ? v.toLowerCase().replaceAll("-", "") : "";
}
async function checked(url: string, init: RequestInit = {}): Promise<Response> {
  try { return await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(12000) }); }
  catch { throw new BookingProviderCanaryError("booking_provider_result_uncertain", 503); }
}
async function json(response: Response): Promise<Record<string, unknown>> {
  try {
    const obj = await response.json();
    if (!obj || typeof obj !== "object") throw Error("bad response");
    return obj as Record<string, unknown>;
  } catch { throw new BookingProviderCanaryError("booking_provider_response_invalid", 503); }
}
async function notionPage(): Promise<Record<string, unknown>> {
  const response = await checked(NOTION, {
    headers: { Authorization: "Bearer " + process.env.INTERVIEW_NOTION_LIVE_TOKEN,
      "Notion-Version": "2022-06-28" },
  });
  if (!response.ok) throw new BookingProviderCanaryError("booking_provider_notion_read_failed", 503);
  const page = await json(response);
  const parent = page.parent as { type?: string; database_id?: string } | undefined;
  const props = page.properties as Record<string, { email?: string }> | undefined;
  if (normalize(page.id) !== PAGE || page.archived || page.in_trash ||
      parent?.type !== "database_id" || !parent.database_id ||
      props?.Email?.email?.toLowerCase() !== RECIPIENT) {
    throw new BookingProviderCanaryError("booking_provider_notion_identity_mismatch", 403);
  }
  try { assertCampusPipelineParent("BU", parent.database_id); }
  catch { throw new BookingProviderCanaryError("booking_provider_notion_wrong_campus", 403); }
  return page;
}
function propertyString(page: Record<string, unknown>, field: string): string {
  const p = (page.properties as Record<string, { rich_text?: Array<{ plain_text?: string }> }>)[field];
  return p?.rich_text?.map(x => x.plain_text ?? "").join("") ?? "";
}
async function patchNotion(properties: Record<string, unknown>): Promise<void> {
  const response = await checked(NOTION, {
    method: "PATCH",
    headers: { Authorization: "Bearer " + process.env.INTERVIEW_NOTION_LIVE_TOKEN,
      "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
    body: JSON.stringify({ properties }),
  });
  if (!response.ok) throw new BookingProviderCanaryError("booking_provider_notion_write_uncertain", 503);
  const page = await json(response);
  if (normalize(page.id) !== PAGE) throw new BookingProviderCanaryError("booking_provider_notion_write_identity_mismatch", 503);
}
function eventIsOurs(event: Record<string, unknown>): boolean {
  const props = event.extendedProperties as {private?: Record<string, unknown>} | undefined;
  return event.id === EVENT_ID && props?.private?.c2cProviderCanary === ID;
}
async function calendarToken(): Promise<string> {
  try { return await googleProviderAccessToken("calendar"); }
  catch { throw new BookingProviderCanaryError("booking_provider_calendar_auth_failed", 503); }
}
async function eventLookup(token: string): Promise<Record<string, unknown> | null> {
  const response = await checked(CALENDAR + "/" + EVENT_ID, {
    headers: { Authorization: "Bearer " + token },
  });
  if ([404, 410].includes(response.status)) return null;
  if (!response.ok) throw new BookingProviderCanaryError("booking_provider_calendar_lookup_failed", 503);
  const data = await json(response);
  if (!eventIsOurs(data)) throw new BookingProviderCanaryError("booking_provider_unrecognized_event", 409);
  return data;
}
function meetUrl(event: Record<string, unknown>): string {
  const conference = event.conferenceData as {entryPoints?: Array<{entryPointType?:string;uri?:string}>} | undefined;
  const value = event.hangoutLink ?? conference?.entryPoints?.find(x => x.entryPointType === "video")?.uri;
  if (typeof value !== "string" || !/^https:\/\/meet\.google\.com\/[a-z0-9-]+$/.test(value)) {
    throw new BookingProviderCanaryError("booking_provider_meet_pending", 409);
  }
  return value;
}
async function assertFreeCalendar(token: string) {
  const response = await checked("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin: START, timeMax: END,
      timeZone: "America/New_York", items: [{id:"primary"}] }),
  });
  if (!response.ok) throw new BookingProviderCanaryError("booking_provider_freebusy_failed", 503);
  const payload = await json(response);
  const entries = payload.calendars as Record<string,{busy?: unknown[]; errors?: unknown[]}> | undefined;
  const primary = entries?.primary;
  if (!primary || !Array.isArray(primary.busy) || primary.busy.length ||
      (Array.isArray(primary.errors) && primary.errors.length)) {
    throw new BookingProviderCanaryError("booking_provider_test_time_unavailable", 409);
  }
}
async function createEvent(token: string): Promise<{eventId:string;meet:string}> {
  const prior = await eventLookup(token);
  if (prior) return {eventId: EVENT_ID,meet:meetUrl(prior)};
  await assertFreeCalendar(token);
  const response = await checked(CALENDAR + "?conferenceDataVersion=1&sendUpdates=none",{
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({
      id: EVENT_ID,
      summary: "[SYSTEM TEST] Campus2Care interview booking canary",
      description: "SYNTHETIC SYSTEM TEST. No volunteer or staff interviewer. Do not attend.",
      visibility: "private", guestsCanInviteOthers: false, guestsCanModify: false,
      // Exactly one recipient, the founder-approved Campus2Care test alias.
      attendees: [{email: RECIPIENT}],
      start: {dateTime:START,timeZone:"America/New_York"},
      end: {dateTime:END,timeZone:"America/New_York"},
      extendedProperties: {private:{c2cProviderCanary:ID}},
      conferenceData: {createRequest:{
        requestId: digest("meet:"+ID).slice(0,40),
        conferenceSolutionKey:{type:"hangoutsMeet"},
      }},
    }),
  });
  if (response.status === 409) {
    const existing = await eventLookup(token);
    if (!existing) throw new BookingProviderCanaryError("booking_provider_event_race_unknown",503);
    return {eventId:EVENT_ID, meet:meetUrl(existing)};
  }
  if (!response.ok) throw new BookingProviderCanaryError("booking_provider_event_creation_uncertain",503);
  const event = await json(response);
  if (!eventIsOurs(event)) throw new BookingProviderCanaryError("booking_provider_event_identity_mismatch",503);
  let link: string;
  try { link = meetUrl(event); }
  catch {
    const refreshed = await eventLookup(token);
    if (!refreshed) throw new BookingProviderCanaryError("booking_provider_event_missing_after_create",503);
    link = meetUrl(refreshed);
  }
  return { eventId:EVENT_ID, meet:link };
}
async function sendConfirmation(meet: string): Promise<string> {
  const operationKey = "c2c_provider_canary_BU_20261029";
  const message = renderInterviewMessage({ kind:"confirmation",operationKey,
    recipient:RECIPIENT,campus:"BU",startsAt:START,meetUrl:meet });
  const digestValue = digest(operationKey);
  const boundary = "c2c_" + digestValue;
  const mime = [
    "From: Campus2Care <contact@campus2care.org>",
    "To: "+RECIPIENT,
    "Reply-To: contact@campus2care.org",
    "Subject: [SYSTEM TEST] "+message.subject,
    "Message-ID: <"+digestValue+"@campus2care.org>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="'+boundary+'"',
    "", "--"+boundary, 'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64","",Buffer.from(message.text).toString("base64"),
    "--"+boundary, 'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64","",Buffer.from(message.html).toString("base64"),
    "--"+boundary+"--","",
  ].join("\r\n");
  let token: string;
  try { token = await googleProviderAccessToken("gmail"); }
  catch { throw new BookingProviderCanaryError("booking_provider_gmail_auth_failed",503); }
  const response = await checked("https://gmail.googleapis.com/gmail/v1/users/me/messages/send",{
    method:"POST",
    headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},
    body:JSON.stringify({raw:Buffer.from(mime).toString("base64url")}),
  });
  if(!response.ok)throw new BookingProviderCanaryError("booking_provider_mail_uncertain",503);
  const payload = await json(response);
  if(typeof payload.id!=="string" || !/^[A-Za-z0-9_-]{5,200}$/.test(payload.id)) {
    throw new BookingProviderCanaryError("booking_provider_mail_acceptance_unknown",503);
  }
  return payload.id;
}
async function readLedger(): Promise<Ledger | null> {
  const db = productionVerificationCanaryDatabase();
  const rows = await db<Ledger[]>`SELECT id,state,calendar_event_id,meet_url,gmail_message_id,email_attempted_at
    FROM interview.booking_provider_canary WHERE id=${ID}`;
  return rows[0]??null;
}
export async function bookingProviderCanaryStatus() {
  bookingProviderCanaryConfig();
  const row = await readLedger();
  return { campus:"BU", testRecipient:RECIPIENT, appointmentStart:START,
    state:row?.state??"not_started",
    calendarEventCreated:!!row?.calendar_event_id,
    notionSynchronized:["notion_synced","sending_email","complete","cleanup_started","event_canceled"].includes(row?.state??""),
    emailAttempted:!!row?.email_attempted_at,
    gmailAccepted:!!row?.gmail_message_id,
    meetUrl:row?.meet_url??null };
}

export async function runBookingProviderCanary() {
  bookingProviderCanaryConfig();
  // Never touch any real person or slot. Immutable test ID, page, recipient and start.
  assertProductionVerificationIdentity("BU", RECIPIENT, PAGE);
  const db = productionVerificationCanaryDatabase();
  await verifyLiveCanaryApplicant({campus:"BU",email:RECIPIENT,pageId:PAGE},
    {verificationOnly:true});
  const page = await notionPage();
  if(propertyString(page,"Scheduling Reservation ID") ||
     (page.properties as Record<string,{select?:{name?:string}}> )["Interview Status"]?.select?.name!=="Not Scheduled") {
    throw new BookingProviderCanaryError("booking_provider_test_record_not_clean",409);
  }
  const other = await db<{total:number}[]>`SELECT COUNT(*)::int AS total FROM interview.schedule_slot
    WHERE starts_at=${START}::timestamptz`;
  if ((other[0]?.total??0)>0) throw new BookingProviderCanaryError("booking_provider_approved_slot_conflict",409);
  await db`INSERT INTO interview.booking_provider_canary
    (id,campus,notion_page_id,recipient_email,starts_at,state)
    VALUES(${ID},'BU',${PAGE},${RECIPIENT},${START}::timestamptz,'new')
    ON CONFLICT (id) DO NOTHING`;
  const locked=await db<{id:string}[]>`UPDATE interview.booking_provider_canary
    SET state='creating_event',updated_at=now()
    WHERE id=${ID} AND state='new' RETURNING id`;
  if(!locked.length) throw new BookingProviderCanaryError("booking_provider_canary_already_attempted",409);
  try {
    const calendarTokenValue = await calendarToken();
    const event = await createEvent(calendarTokenValue);
    await db`UPDATE interview.booking_provider_canary SET
      state='event_created',calendar_event_id=${event.eventId},meet_url=${event.meet},
      updated_at=now() WHERE id=${ID} AND state='creating_event'`;
    await patchNotion(confirmedInterviewNotionProperties({
      campus:"BU", utcStart:START,reservationId:RESERVATION_ID,
      interviewerEmail:"interviews@campus2care.org",meetUrl:event.meet,
    }));
    await db`UPDATE interview.booking_provider_canary SET state='notion_synced',updated_at=now()
      WHERE id=${ID} AND state='event_created'`;
    // Record the attempt BEFORE Gmail network I/O. Never automatically resend.
    await db`UPDATE interview.booking_provider_canary SET state='sending_email',
      email_attempted_at=now(),updated_at=now()
      WHERE id=${ID} AND state='notion_synced'`;
    const gmailId = await sendConfirmation(event.meet);
    await db`UPDATE interview.booking_provider_canary SET state='complete',
      gmail_message_id=${gmailId},updated_at=now()
      WHERE id=${ID} AND state='sending_email'`;
    return bookingProviderCanaryStatus();
  } catch {
    // Some provider writes may have succeeded. Fail closed, no automatic retry.
    await db`UPDATE interview.booking_provider_canary SET
      state='reconcile_required',updated_at=now()
      WHERE id=${ID} AND state IN ('creating_event','event_created','notion_synced','sending_email')`;
    throw new BookingProviderCanaryError("booking_provider_canary_reconciliation_required",503);
  }
}
export async function cleanupBookingProviderCanary() {
  bookingProviderCanaryConfig();
  const db = productionVerificationCanaryDatabase();
  const current=await readLedger();
  if(!current)throw new BookingProviderCanaryError("booking_provider_canary_missing",404);
  if(current.state==="cleaned")return bookingProviderCanaryStatus();
  // Never automatically clean an uncertain state: investigate the provider result.
  if(current.state!=="complete")throw new BookingProviderCanaryError("booking_provider_manual_reconciliation_required",409);
  const claimed=await db<{id:string}[]>`UPDATE interview.booking_provider_canary
    SET state='cleanup_started',updated_at=now()
    WHERE id=${ID} AND state='complete' RETURNING id`;
  if(!claimed.length)throw new BookingProviderCanaryError("booking_provider_cleanup_already_started",409);
  try {
    const token=await calendarToken();
    const existing=await eventLookup(token);
    if(existing){
      const deleted=await checked(CALENDAR+"/"+EVENT_ID+"?sendUpdates=none",{
        method:"DELETE", headers:{Authorization:"Bearer "+token},
      });
      if(!deleted.ok && ![404,410].includes(deleted.status))
        throw new BookingProviderCanaryError("booking_provider_cancel_uncertain",503);
    }
    await db`UPDATE interview.booking_provider_canary SET
      state='event_canceled',updated_at=now()
      WHERE id=${ID} AND state='cleanup_started'`;
    const page=await notionPage();
    const reservation=propertyString(page,"Scheduling Reservation ID");
    if(reservation!==RESERVATION_ID)
      throw new BookingProviderCanaryError("booking_provider_notion_cleanup_conflict",409);
    // Restore only six test-booking fields. Leave synthetic title, owners and other fields alone.
    await patchNotion({
      "Workflow Status":{select:{name:"Application Received"}},
      "Scheduling Reservation ID":{rich_text:[]},
      "Interview Date":{date:null},
      "Interview Status":{select:{name:"Not Scheduled"}},
      "Interviewed By":{rich_text:[]},
      "Google Meet URL":{url:null},
    });
    await db`UPDATE interview.booking_provider_canary SET
      state='cleaned',updated_at=now()
      WHERE id=${ID} AND state='event_canceled'`;
    return bookingProviderCanaryStatus();
  }catch {
    await db`UPDATE interview.booking_provider_canary SET
      state='reconcile_required',updated_at=now()
      WHERE id=${ID} AND state IN ('cleanup_started','event_canceled')`;
    throw new BookingProviderCanaryError("booking_provider_cleanup_reconciliation_required",503);
  }
}
