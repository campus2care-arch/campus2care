/**
 * Google Calendar write adapter for synthetic staging verification only.
 *
 * It needs an independently
 * granted interviews@ API token; ChatGPT connector access and staff sign-in
 * tokens are not valid substitutes. Attendees require a separate synthetic-only opt-in.
 */
import { createHash } from "node:crypto";

const API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export class InterviewCalendarProviderError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "InterviewCalendarProviderError";
  }
}

export type SyntheticCalendarEvent = {
  id: string;
  status: string;
  meetUrl: string | null;
};

type GoogleEvent = {
  id?: unknown;
  status?: unknown;
  conferenceData?: {
    entryPoints?: Array<{ entryPointType?: unknown; uri?: unknown }>;
  };
  extendedProperties?: { private?: Record<string, string> };
};

function enabled(): boolean {
  return process.env.VERCEL_ENV === "preview" &&
    (process.env.INTERVIEW_CALENDAR_WRITES_ENABLED === "true" ||
      process.env.INTERVIEW_SYNTHETIC_CALENDAR_ENABLED === "true");
}

function eventId(operationKey: string): string {
  // Google event IDs accept lowercase base32hex characters; a SHA-256 hex
  // digest also gives one deterministic event ID per outbox operation.
  return "c2c" + createHash("sha256").update(operationKey).digest("hex");
}

function validInput(input: {
  accessToken: string;
  operationKey: string;
  startsAt: string;
  endsAt: string;
  attendees?: string[];
  teamDescription?: string;
}): void {
  if (!enabled()) throw new InterviewCalendarProviderError("calendar_writes_disabled");
  if (typeof input.accessToken !== "string" || input.accessToken.length < 20) {
    throw new InterviewCalendarProviderError("calendar_access_not_granted");
  }
  if (!/^[A-Za-z0-9:_-]{8,160}$/.test(input.operationKey)) {
    throw new InterviewCalendarProviderError("invalid_calendar_operation_key");
  }
  if(input.attendees!==undefined&&(process.env.INTERVIEW_SYNTHETIC_ATTENDEES_ENABLED!=="true"||!Array.isArray(input.attendees)||input.attendees.length!==2||!input.attendees.includes("bob@campus2care.org")||input.attendees.filter(email=>/^[a-z0-9._+-]+@example\.invalid$/.test(email)).length!==1))throw new InterviewCalendarProviderError("synthetic_calendar_attendees_forbidden");
  const start = Date.parse(input.startsAt);
  const end = Date.parse(input.endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) ||
      new Date(start).toISOString() !== input.startsAt ||
      new Date(end).toISOString() !== input.endsAt ||
      end - start !== 20 * 60_000) {
    throw new InterviewCalendarProviderError("invalid_calendar_event_interval");
  }
}

async function request(
  accessToken: string,
  url: string,
  init: RequestInit,
  transport: typeof fetch,
): Promise<Response> {
  try {
    return await transport(url, {
      ...init,
      headers: { Authorization: "Bearer " + accessToken, ...init.headers },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new InterviewCalendarProviderError("calendar_provider_outcome_unknown");
  }
}

async function eventFromResponse(response: Response): Promise<GoogleEvent> {
  try {
    const value = await response.json() as GoogleEvent;
    if (typeof value?.id !== "string" || typeof value.status !== "string") {
      throw new Error("malformed");
    }
    return value;
  } catch {
    throw new InterviewCalendarProviderError("calendar_provider_malformed_response");
  }
}

function normalize(event: GoogleEvent): SyntheticCalendarEvent {
  const meetUrl = event.conferenceData?.entryPoints?.find(
    (entry) => entry.entryPointType === "video" && typeof entry.uri === "string",
  )?.uri;
  if (typeof meetUrl === "string" && !/^https:\/\/meet\.google\.com\/[a-z0-9-]+$/i.test(meetUrl)) {
    throw new InterviewCalendarProviderError("calendar_invalid_meet_url");
  }
  return {
    id: event.id as string,
    status: event.status as string,
    meetUrl: typeof meetUrl === "string" ? meetUrl : null,
  };
}

async function getById(
  accessToken: string,
  id: string,
  transport: typeof fetch,
): Promise<SyntheticCalendarEvent | null> {
  const response = await request(accessToken, API + "/" + encodeURIComponent(id), {
    method: "GET",
  }, transport);
  if (response.status === 404) return null;
  if (response.status === 410) return { id, status: "cancelled", meetUrl: null };
  if (!response.ok) {
    throw new InterviewCalendarProviderError("calendar_event_lookup_unavailable");
  }
  return normalize(await eventFromResponse(response));
}

/**
 * Insert exactly one attendee-free synthetic event. A deterministic Google
 * event ID prevents duplicate events if a request is retried after a timeout.
 * A missing Meet URL is a pending conference, not a confirmed interview.
 */
export async function createSyntheticInterviewCalendarEvent(
  input: {
    accessToken: string;
    operationKey: string;
    startsAt: string;
    endsAt: string;
    attendees?: string[];
  teamDescription?: string;
  },
  transport: typeof fetch = fetch,
): Promise<SyntheticCalendarEvent> {
  validInput(input);
  const id = eventId(input.operationKey);
  const existing = await getById(input.accessToken, id, transport);
  if (existing) return existing;

  const requestId = createHash("sha256").update("meet:" + input.operationKey)
    .digest("hex").slice(0, 40);
  const response = await request(input.accessToken,
    API + "?conferenceDataVersion=1&sendUpdates=none", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        ...(input.attendees?{attendees:input.attendees.map(email=>({email,responseStatus:"needsAction"})),guestsCanModify:false,guestsCanInviteOthers:false}:{}),
        summary: "Campus2Care synthetic interview integration test",
        visibility: "private",
        transparency: "transparent",
        description: "Synthetic staging verification. No real applicant is invited." + (input.teamDescription ? "\n" + input.teamDescription.slice(0, 2000) : ""),
        start: { dateTime: input.startsAt, timeZone: "America/New_York" },
        end: { dateTime: input.endsAt, timeZone: "America/New_York" },
        extendedProperties: { private: { c2cOperationKey: input.operationKey } },
        conferenceData: {
          createRequest: {
            requestId,
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        },
      }),
    }, transport);

  if (response.status === 409) {
    // Another request may have won the deterministic-ID race; read it back.
    const raced = await getById(input.accessToken, id, transport);
    if (raced) return raced;
    throw new InterviewCalendarProviderError("calendar_event_conflict_unresolved");
  }
  if (!response.ok) {
    // A provider error can be ambiguous. Reconciliation must look up this
    // deterministic event ID before any caller considers retrying.
    throw new InterviewCalendarProviderError("calendar_event_create_outcome_unknown");
  }
  return normalize(await eventFromResponse(response));
}

export async function readSyntheticInterviewCalendarEvent(
  accessToken: string,
  operationKey: string,
  transport: typeof fetch = fetch,
): Promise<SyntheticCalendarEvent | null> {
  if (!enabled()) throw new InterviewCalendarProviderError("calendar_writes_disabled");
  if (typeof accessToken !== "string" || accessToken.length < 20 ||
      !/^[A-Za-z0-9:_-]{8,160}$/.test(operationKey)) {
    throw new InterviewCalendarProviderError("invalid_calendar_lookup");
  }
  return getById(accessToken, eventId(operationKey), transport);
}

export async function cancelSyntheticInterviewCalendarEvent(
  accessToken: string,
  operationKey: string,
  transport: typeof fetch = fetch,
): Promise<boolean> {
  if (!enabled()) throw new InterviewCalendarProviderError("calendar_writes_disabled");
  if (typeof accessToken !== "string" || accessToken.length < 20 ||
      !/^[A-Za-z0-9:_-]{8,160}$/.test(operationKey)) {
    throw new InterviewCalendarProviderError("invalid_calendar_lookup");
  }
  const response = await request(accessToken,
    API + "/" + encodeURIComponent(eventId(operationKey)) + "?sendUpdates=none", {
      method: "DELETE",
    }, transport);
  if (response.status === 404 || response.status === 410 || response.ok) return true;
  throw new InterviewCalendarProviderError("calendar_event_cancel_outcome_unknown");
}
