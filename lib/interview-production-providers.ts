import { googleProviderAccessToken } from "./interview-google-provider-auth";
import { createHash } from "node:crypto";
import { productionCanaryConfig, assertProductionCanaryIdentity } from "./interview-production-canary";
import {
  assertCampusPipelineParent, confirmedInterviewNotionProperties,
  evaluateInitialInterviewEligibility, type Campus,
} from "./interview-notion-contract";
import { renderInterviewMessage } from "./interview-email";

export class ProductionProviderError extends Error {
  constructor(public readonly code: string, public readonly disposition: "retry" | "reconcile_required" | "failed") {
    super(code);
    this.name = "ProductionProviderError";
  }
}
export type ProductionCalendarEvent = { id: string; meetUrl: string | null; status: string };
type Transport = typeof fetch;
const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const uuid = (v: string) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const normalize = (v: string) => v.toLowerCase().replaceAll("-", "");
const safeEmail = (v: string) => /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(v);
const digest = (v: string) => createHash("sha256").update(v).digest("hex");

async function send(transport: Transport, url: string, init: RequestInit): Promise<Response> {
  try {
    return await transport(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(10000) });
  } catch {
    throw new ProductionProviderError("production_provider_outcome_unknown", "reconcile_required");
  }
}
async function json(response: Response): Promise<Record<string, unknown>> {
  try {
    const body = await response.json();
    if (!body || typeof body !== "object") throw Error("invalid");
    return body as Record<string, unknown>;
  } catch { throw new ProductionProviderError("production_provider_response_invalid", "reconcile_required"); }
}

/** OAuth grants belong to the organization-owned provider accounts, not the staff sign-in. */
export async function productionGoogleAccessToken(
  provider: "calendar" | "gmail", transport: Transport = fetch,
): Promise<string> {
  productionCanaryConfig();
  const refresh = provider === "calendar"
    ? process.env["INTERVIEW_PRODUCTION_CALENDAR_REFRESH_TOKEN"]
    : process.env["INTERVIEW_PRODUCTION_GMAIL_REFRESH_TOKEN"];
  const clientId = process.env["INTERVIEW_GOOGLE_CLIENT_ID"] ?? "";
  const secret = process.env["INTERVIEW_GOOGLE_CLIENT_SECRET"] ?? "";
  if (!refresh) return googleProviderAccessToken(provider, transport);
  if (refresh.length < 20 || clientId.length < 10 || secret.length < 10) {
    throw new ProductionProviderError("production_google_oauth_not_configured", "failed");
  }
  const result = await send(transport, "https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token",
    }),
  });
  if (!result.ok) throw new ProductionProviderError("production_google_oauth_unavailable", "retry");
  const payload = await json(result);
  const token = payload.access_token;
  if (typeof token !== "string" || token.length < 20) {
    throw new ProductionProviderError("production_google_oauth_invalid", "failed");
  }
  const identityResult = await send(transport, "https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: "Bearer " + token },
  });
  if (!identityResult.ok) throw new ProductionProviderError("production_google_identity_unavailable", "retry");
  const account = await json(identityResult);
  const expected = provider === "calendar" ? "interviews@campus2care.org" : "contact@campus2care.org";
  if (account.email !== expected || account.email_verified !== true) {
    throw new ProductionProviderError("production_google_wrong_account", "failed");
  }
  return token;
}

export function productionCalendarEventId(operationKey: string): string {
  if (!/^interview-calendar:create:[0-9a-f-]{36}$/i.test(operationKey)) {
    throw new ProductionProviderError("production_calendar_invalid_operation", "failed");
  }
  return "c2c" + digest(operationKey);
}
function parsedCalendarEvent(value: Record<string, unknown>, operationKey: string): ProductionCalendarEvent {
  const expectedId = productionCalendarEventId(operationKey);
  const fields = value.extendedProperties as { private?: Record<string, unknown> } | undefined;
  if (value.id !== expectedId || !["confirmed", "cancelled"].includes(String(value.status)) ||
      fields?.private?.c2cOperationKey !== operationKey) {
    throw new ProductionProviderError("production_calendar_event_mismatch", "reconcile_required");
  }
  const data = value.conferenceData as { entryPoints?: Array<{entryPointType?: string; uri?: string}> } | undefined;
  const url = data?.entryPoints?.find(x => x.entryPointType === "video")?.uri ?? null;
  if (url && !/^https:\/\/meet\.google\.com\/[a-z0-9-]+$/i.test(url)) {
    throw new ProductionProviderError("production_calendar_invalid_meet", "reconcile_required");
  }
  return { id: expectedId, status: String(value.status), meetUrl: url };
}
export type ProductionCalendarInput = {
  operationKey: string; reservationId: string; campus: Campus; pageId: string;
  applicantEmail: string; participants: Array<{email: string; role: "lead" | "shadow"}>;
  startsAt: string; endsAt: string;
};

/** GET-before-POST with deterministic event ID: retries cannot create two meetings. */
export async function createOrReadProductionInterviewEvent(
  input: ProductionCalendarInput, transport: Transport = fetch,
): Promise<ProductionCalendarEvent> {
  productionCanaryConfig();
  assertProductionCanaryIdentity(input.campus, input.applicantEmail, input.pageId);
  // Calendar's sendUpdates=all notifies real staff attendees; require separate approval.
  if (process.env["INTERVIEW_PRODUCTION_CALENDAR_INVITES_APPROVED"] !== "true") {
    throw new ProductionProviderError("production_staff_invitations_not_approved", "failed");
  }
  const start = Date.parse(input.startsAt), end = Date.parse(input.endsAt);
  if (!uuid(input.reservationId) || input.operationKey !== "interview-calendar:create:" + input.reservationId ||
      !Number.isFinite(start) || !Number.isFinite(end) || end - start !== 20 * 60000 ||
      new Date(start).toISOString() !== input.startsAt || new Date(end).toISOString() !== input.endsAt ||
      input.participants.length < 2 || input.participants.length > 12 ||
      input.participants.filter(p => p.role === "lead").length !== 1 ||
      input.participants.some(p => !/^[a-z0-9._%+-]+@campus2care\.org$/i.test(p.email))) {
    throw new ProductionProviderError("production_calendar_invalid_input", "failed");
  }
  const attendees = [...new Set([...input.participants.map(x => x.email.toLowerCase()), input.applicantEmail])];
  if (attendees.length !== input.participants.length + 1) {
    throw new ProductionProviderError("production_calendar_duplicate_attendee", "failed");
  }
  const token = await productionGoogleAccessToken("calendar", transport);
  const id = productionCalendarEventId(input.operationKey);
  const auth = { Authorization: "Bearer " + token };
  const existing = await send(transport, CALENDAR + "/" + encodeURIComponent(id), { headers: auth });
  if (existing.ok) return parsedCalendarEvent(await json(existing), input.operationKey);
  if (existing.status !== 404) {
    throw new ProductionProviderError("production_calendar_lookup_failed", "reconcile_required");
  }
  const response = await send(transport, CALENDAR + "?conferenceDataVersion=1&sendUpdates=all", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      id, summary: "Campus2Care Volunteer Interview",
      description: "Campus2Care volunteer interview. Please join using the unique Google Meet link in this invitation.",
      visibility: "private", guestsCanInviteOthers: false, guestsCanModify: false,
      attendees: attendees.map(email => ({ email, responseStatus: "needsAction" })),
      start: { dateTime: input.startsAt, timeZone: "America/New_York" },
      end: { dateTime: input.endsAt, timeZone: "America/New_York" },
      extendedProperties: { private: { c2cOperationKey: input.operationKey, c2cReservationId: input.reservationId } },
      conferenceData: { createRequest: {
        requestId: digest("meet:" + input.operationKey).slice(0, 40),
        conferenceSolutionKey: { type: "hangoutsMeet" },
      } },
    }),
  });
  if (response.status === 409) {
    const raced = await send(transport, CALENDAR + "/" + encodeURIComponent(id), { headers: auth });
    if (!raced.ok) throw new ProductionProviderError("production_calendar_conflict_unresolved", "reconcile_required");
    return parsedCalendarEvent(await json(raced), input.operationKey);
  }
  if (!response.ok) throw new ProductionProviderError("production_calendar_create_unknown", "reconcile_required");
  return parsedCalendarEvent(await json(response), input.operationKey);
}

export type ProductionNotionWrite = {
  campus: Campus; pageId: string; applicantEmail: string; reservationId: string;
  startsAt: string; interviewerEmail: string; meetUrl: string;
};

/** Idempotent interview-field-only update. Any differing booking is quarantined. */
export async function syncProductionInterviewNotion(
  input: ProductionNotionWrite, transport: Transport = fetch,
): Promise<"written" | "already_synced"> {
  productionCanaryConfig();
  assertProductionCanaryIdentity(input.campus, input.applicantEmail, input.pageId);
  const token = process.env["INTERVIEW_NOTION_LIVE_TOKEN"] ?? "";
  if (token.length < 20) throw new ProductionProviderError("production_notion_oauth_missing", "failed");
  const api = "https://api.notion.com/v1/pages/" + normalize(input.pageId);
  const headers = {
    Authorization: "Bearer " + token, "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
  };
  const lookup = await send(transport, api, { headers });
  if (!lookup.ok) {
    throw new ProductionProviderError("production_notion_lookup_unavailable", lookup.status === 429 ? "retry" : "reconcile_required");
  }
  const page = await json(lookup);
  const parent = page.parent as { database_id?: unknown; type?: unknown } | undefined;
  const properties = page.properties as Record<string, {email?: string; rich_text?: Array<{plain_text?: string}>; url?: string; select?: {name?: string}}> | undefined;
  if (normalize(String(page.id ?? "")) !== normalize(input.pageId) || page.archived || page.in_trash ||
      parent?.type !== "database_id" || !parent.database_id || !properties ||
      properties.Email?.email?.toLowerCase() !== input.applicantEmail.toLowerCase()) {
    throw new ProductionProviderError("production_notion_identity_mismatch", "failed");
  }
  try { assertCampusPipelineParent(input.campus, String(parent.database_id)); }
  catch { throw new ProductionProviderError("production_notion_campus_mismatch", "failed"); }
  const existing = properties["Scheduling Reservation ID"]?.rich_text?.map(x => x.plain_text ?? "").join("") ?? "";
  if (existing && existing !== input.reservationId) {
    throw new ProductionProviderError("production_notion_other_booking", "reconcile_required");
  }
  if (existing === input.reservationId) {
    if (properties["Interview Status"]?.select?.name === "Scheduled" && properties["Google Meet URL"]?.url === input.meetUrl) {
      return "already_synced";
    }
    throw new ProductionProviderError("production_notion_partial_update", "reconcile_required");
  }
  if (properties["Interview Status"]?.select?.name !== "Not Scheduled") {
    throw new ProductionProviderError("production_notion_status_changed", "reconcile_required");
  }
  // A previously eligible applicant can withdraw before the Notion write.
  const decision = evaluateInitialInterviewEligibility(input.campus, {
    email: input.applicantEmail,
    stage: properties.Stage?.select?.name ?? null,
    nextStep: properties["Next Step"]?.select?.name ?? null,
    interviewStatus: properties["Interview Status"]?.select?.name ?? null,
    workflowStatus: properties["Workflow Status"]?.select?.name ?? null,
  });
  if (!decision.eligible) {
    throw new ProductionProviderError("production_notion_eligibility_changed", "reconcile_required");
  }
  const patch = confirmedInterviewNotionProperties({
    campus: input.campus, utcStart: input.startsAt, reservationId: input.reservationId,
    interviewerEmail: input.interviewerEmail, meetUrl: input.meetUrl,
  });
  const updated = await send(transport, api, {
    method: "PATCH", headers, body: JSON.stringify({properties:patch}),
  });
  if (!updated.ok) {
    throw new ProductionProviderError("production_notion_write_unknown", "reconcile_required");
  }
  return "written";
}

export type ProductionGmailInput = {
  operationKey: string; campus: Campus; pageId: string; email: string; reservationId: string;
  startsAt: string; meetUrl: string;
};
/** Gmail has no application-level send idempotency token: ambiguous sends are quarantined. */
export async function sendProductionInterviewConfirmation(
  input: ProductionGmailInput, transport: Transport = fetch,
): Promise<string> {
  productionCanaryConfig();
  assertProductionCanaryIdentity(input.campus, input.email, input.pageId);
  if (!uuid(input.reservationId) || input.operationKey !== "interview-mail:confirmation:" + input.reservationId ||
      !safeEmail(input.email)) {
    throw new ProductionProviderError("production_gmail_invalid_message", "failed");
  }
  const view = renderInterviewMessage({
    operationKey: input.operationKey, recipient: input.email, campus: input.campus,
    kind: "confirmation", startsAt: input.startsAt, meetUrl: input.meetUrl,
  });
  const token = await productionGoogleAccessToken("gmail", transport);
  const hash = digest(input.operationKey);
  const boundary = "c2c_" + hash;
  const mime = [
    "From: Campus2Care <contact@campus2care.org>", "To: " + input.email,
    "Reply-To: contact@campus2care.org", "Subject: " + view.subject,
    "Message-ID: <" + hash + "@campus2care.org>", "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
    "", "--" + boundary, 'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64", "", Buffer.from(view.text).toString("base64"),
    "--" + boundary, 'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64", "", Buffer.from(view.html).toString("base64"),
    "--" + boundary + "--", "",
  ].join("\r\n");
  const response = await send(transport, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({raw: Buffer.from(mime).toString("base64url")}),
  });
  if (!response.ok) throw new ProductionProviderError("production_gmail_send_unknown", "reconcile_required");
  const result = await json(response);
  if (typeof result.id !== "string" || !result.id || result.id.length > 200) {
    throw new ProductionProviderError("production_gmail_acceptance_unknown", "reconcile_required");
  }
  return result.id;
}
