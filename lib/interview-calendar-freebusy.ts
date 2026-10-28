import { authorizedRole } from "./interview-auth";

export type CalendarBusyInterval = {
  start: string;
  end: string;
};

export class CalendarFreeBusyError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "CalendarFreeBusyError";
  }
}

export function calendarReadAccessEnabled(): boolean {
  return process.env.VERCEL_ENV === "preview" &&
    process.env.INTERVIEW_CALENDAR_READS_ENABLED === "true";
}

/**
 * An explicitly granted Calendar OAuth token must be passed by the
 * server-side credential service. The staff sign-in ID token is NOT an API
 * authorization token. This module neither stores nor obtains credentials.
 */
export async function readInterviewerFreeBusy(
  input: {
    calendarId: string;
    accessToken: string;
    startsAt: string;
    endsAt: string;
  },
  transport: typeof fetch = fetch,
): Promise<CalendarBusyInterval[]> {
  if (!calendarReadAccessEnabled()) {
    throw new CalendarFreeBusyError("calendar_read_access_disabled");
  }
  const calendarId = input.calendarId?.trim().toLowerCase();
  if (!calendarId || !authorizedRole(calendarId)) {
    throw new CalendarFreeBusyError("calendar_interviewer_not_authorized");
  }
  if (typeof input.accessToken !== "string" || input.accessToken.length < 20) {
    throw new CalendarFreeBusyError("calendar_access_not_granted");
  }
  const start = new Date(input.startsAt);
  const end = new Date(input.endsAt);
  if (!Number.isFinite(start.getTime()) ||
      !Number.isFinite(end.getTime()) ||
      start.getTime() >= end.getTime() ||
      end.getTime() - start.getTime() > 7 * 86400000 ||
      start.toISOString() !== input.startsAt ||
      end.toISOString() !== input.endsAt) {
    throw new CalendarFreeBusyError("invalid_calendar_interval");
  }

  let response: Response;
  try {
    response = await transport("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + input.accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        timeMin: input.startsAt,
        timeMax: input.endsAt,
        timeZone: "America/New_York",
        items: [{ id: calendarId }],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new CalendarFreeBusyError("calendar_freebusy_unreachable");
  }

  if (!response.ok) {
    // Provider response and headers are intentionally not logged; they may
    // contain identifiers or account details.
    throw new CalendarFreeBusyError("calendar_freebusy_unavailable");
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new CalendarFreeBusyError("calendar_freebusy_malformed");
  }
  if (!data || typeof data !== "object" || !("calendars" in data) ||
      !data.calendars || typeof data.calendars !== "object") {
    throw new CalendarFreeBusyError("calendar_freebusy_malformed");
  }
  const calendars = data.calendars as Record<string, unknown>;
  const item = calendars[calendarId];
  if (!item || typeof item !== "object") {
    throw new CalendarFreeBusyError("calendar_freebusy_missing_calendar");
  }
  const record = item as { errors?: unknown; busy?: unknown };
  if (Array.isArray(record.errors) && record.errors.length > 0) {
    throw new CalendarFreeBusyError("calendar_freebusy_calendar_error");
  }
  if (!Array.isArray(record.busy)) {
    throw new CalendarFreeBusyError("calendar_freebusy_malformed");
  }
  const busy: CalendarBusyInterval[] = [];
  for (const interval of record.busy) {
    if (!interval || typeof interval !== "object") {
      throw new CalendarFreeBusyError("calendar_freebusy_malformed");
    }
    const entry = interval as { start?: unknown; end?: unknown };
    if (typeof entry.start !== "string" || typeof entry.end !== "string") {
      throw new CalendarFreeBusyError("calendar_freebusy_malformed");
    }
    const from = Date.parse(entry.start);
    const to = Date.parse(entry.end);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
      throw new CalendarFreeBusyError("calendar_freebusy_malformed");
    }
    busy.push({ start: new Date(from).toISOString(), end: new Date(to).toISOString() });
  }
  return busy.sort((a, b) => a.start.localeCompare(b.start));
}

/** Half-open intervals, including the 5-minute scheduling buffer. */
export function calendarSlotIsFree(
  startsAt: string,
  endsAt: string,
  busy: CalendarBusyInterval[],
  bufferMinutes = 5,
): boolean {
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) ||
      start >= end || !Number.isInteger(bufferMinutes) ||
      bufferMinutes < 0 || bufferMinutes > 30 || !Array.isArray(busy)) {
    throw new CalendarFreeBusyError("invalid_calendar_interval");
  }
  const blockedUntil = end + bufferMinutes * 60000;
  for (const entry of busy) {
    const busyStart = Date.parse(entry.start);
    const busyEnd = Date.parse(entry.end);
    if (!Number.isFinite(busyStart) || !Number.isFinite(busyEnd) || busyStart >= busyEnd) {
      throw new CalendarFreeBusyError("calendar_freebusy_malformed");
    }
    if (start < busyEnd && busyStart < blockedUntil) return false;
  }
  return true;
}
