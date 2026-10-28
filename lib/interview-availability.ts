/**
 * Pure, side-effect-free scheduling rules for Campus2Care interviewers.
 *
 * This module deliberately does not authenticate users, read Google calendars,
 * reserve slots, send email, or update Notion. Callers must perform those
 * operations server-side with a transactional lock and permission checks.
 *
 * Dates and times here are America/New_York civil dates/minutes. Convert to
 * instants only at the Calendar API boundary using a timezone-aware library;
 * do not add fixed UTC offsets because daylight saving time changes.
 */

export const INTERVIEW_TIME_ZONE = "America/New_York";
export const INTERVIEW_DURATION_MINUTES = 20;
export const INTERVIEW_BUFFER_MINUTES = 5;

export type TimeWindow = {
  startMinute: number; // Inclusive, local minutes after midnight.
  endMinute: number; // Exclusive; valid range 1..1440.
};

export type WeeklyWindows = {
  weekday: number; // 0=Monday, ..., 6=Sunday.
  windows: TimeWindow[];
};

export type DateOverride = {
  date: string; // Local YYYY-MM-DD within this week.
  kind: "replace" | "unavailable";
  windows?: TimeWindow[]; // Only used when kind="replace".
};

export type WeeklyConfirmation = {
  eaId: string;
  weekStart: string; // Monday in America/New_York.
  status: "pending" | "confirmed" | "unavailable";
  confirmedAt: string | null;
  recurringWindows: WeeklyWindows[];
  overrides: DateOverride[];
};

export type BusyWindow = TimeWindow & { date: string };

export type InterviewSlot = {
  eaId: string;
  date: string;
  startMinute: number;
  endMinute: number;
};

function civilDate(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("invalid_date");
  const result = new Date(date + "T00:00:00.000Z");
  if (Number.isNaN(result.getTime()) || result.toISOString().slice(0, 10) !== date) {
    throw new Error("invalid_date");
  }
  return result;
}

export function mondayForDate(date: string): string {
  const value = civilDate(date);
  const daysSinceMonday = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - daysSinceMonday);
  return value.toISOString().slice(0, 10);
}

export function dateInWeek(weekStart: string, weekday: number): string {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new Error("invalid_weekday");
  }
  if (mondayForDate(weekStart) !== weekStart) throw new Error("week_must_start_monday");
  const value = civilDate(weekStart);
  value.setUTCDate(value.getUTCDate() + weekday);
  return value.toISOString().slice(0, 10);
}

function checkWindow(window: TimeWindow): void {
  if (
    !Number.isInteger(window.startMinute) ||
    !Number.isInteger(window.endMinute) ||
    window.startMinute < 0 ||
    window.endMinute > 1440 ||
    window.startMinute >= window.endMinute
  ) {
    throw new Error("invalid_time_window");
  }
}

function checkWindows(windows: TimeWindow[]): void {
  const sorted = [...windows].sort((a, b) => a.startMinute - b.startMinute);
  for (let i = 0; i < sorted.length; i += 1) {
    checkWindow(sorted[i]);
    if (i > 0 && sorted[i].startMinute < sorted[i - 1].endMinute) {
      throw new Error("overlapping_availability_windows");
    }
  }
}

export function validateWeeklyConfirmation(record: WeeklyConfirmation): void {
  if (!record.eaId.trim()) throw new Error("missing_ea");
  if (mondayForDate(record.weekStart) !== record.weekStart) {
    throw new Error("week_must_start_monday");
  }
  if (!["pending", "confirmed", "unavailable"].includes(record.status)) {
    throw new Error("invalid_confirmation_status");
  }
  if (record.status !== "pending" && !record.confirmedAt) {
    throw new Error("missing_confirmation_timestamp");
  }
  if (record.confirmedAt && Number.isNaN(Date.parse(record.confirmedAt))) {
    throw new Error("invalid_confirmation_timestamp");
  }
  const weekdays = new Set<number>();
  for (const day of record.recurringWindows) {
    if (!Number.isInteger(day.weekday) || day.weekday < 0 || day.weekday > 6) {
      throw new Error("invalid_weekday");
    }
    if (weekdays.has(day.weekday)) throw new Error("duplicate_weekday");
    weekdays.add(day.weekday);
    checkWindows(day.windows);
  }
  const dates = new Set<string>();
  const allowedDates = new Set(
    Array.from({ length: 7 }, (_, weekday) => dateInWeek(record.weekStart, weekday)),
  );
  for (const override of record.overrides) {
    if (!allowedDates.has(override.date)) throw new Error("override_outside_week");
    if (dates.has(override.date)) throw new Error("duplicate_override");
    dates.add(override.date);
    if (override.kind !== "replace" && override.kind !== "unavailable") {
      throw new Error("invalid_override_kind");
    }
    if (override.kind === "replace") checkWindows(override.windows ?? []);
    if (override.kind === "unavailable" && (override.windows?.length ?? 0) > 0) {
      throw new Error("unavailable_override_with_windows");
    }
  }
}

/**
 * Conflicting times can come from confirmed bookings or the assigned EA's
 * Google Calendar free/busy data, not from every event on the master calendar.
 * The buffer is checked after each interview to avoid back-to-back conflicts.
 */
export function buildInterviewSlots(
  record: WeeklyConfirmation,
  eaBusy: BusyWindow[] = [],
  durationMinutes = INTERVIEW_DURATION_MINUTES,
  bufferMinutes = INTERVIEW_BUFFER_MINUTES,
): InterviewSlot[] {
  validateWeeklyConfirmation(record);
  if (
    !Number.isInteger(durationMinutes) ||
    !Number.isInteger(bufferMinutes) ||
    durationMinutes <= 0 ||
    bufferMinutes < 0 ||
    durationMinutes + bufferMinutes > 1440
  ) {
    throw new Error("invalid_slot_parameters");
  }
  if (record.status !== "confirmed") return [];

  const knownDates = new Set(
    Array.from({ length: 7 }, (_, weekday) => dateInWeek(record.weekStart, weekday)),
  );
  for (const conflict of eaBusy) {
    if (!knownDates.has(conflict.date)) throw new Error("busy_outside_week");
    checkWindow(conflict);
  }

  const availability = new Map(record.recurringWindows.map((day) => [day.weekday, day.windows]));
  const overrides = new Map(record.overrides.map((day) => [day.date, day]));
  const slots: InterviewSlot[] = [];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const date = dateInWeek(record.weekStart, weekday);
    const override = overrides.get(date);
    const windows = override
      ? override.kind === "unavailable" ? [] : override.windows ?? []
      : availability.get(weekday) ?? [];

    for (const window of [...windows].sort((a, b) => a.startMinute - b.startMinute)) {
      for (
        let startMinute = window.startMinute;
        startMinute + durationMinutes <= window.endMinute;
        startMinute += durationMinutes + bufferMinutes
      ) {
        const endMinute = startMinute + durationMinutes;
        const reservedUntil = Math.min(1440, endMinute + bufferMinutes);
        const unavailable = eaBusy.some(
          (busy) =>
            busy.date === date &&
            startMinute < busy.endMinute &&
            busy.startMinute < reservedUntil,
        );
        if (!unavailable) slots.push({ eaId: record.eaId, date, startMinute, endMinute });
      }
    }
  }
  return slots;
}

export function availabilityReadiness(records: WeeklyConfirmation[], activeEAIds: string[]) {
  const byEA = new Map<string, WeeklyConfirmation>();
  for (const record of records) {
    validateWeeklyConfirmation(record);
    if (byEA.has(record.eaId)) throw new Error("duplicate_ea_week");
    byEA.set(record.eaId, record);
  }
  return activeEAIds.map((eaId) => {
    const record = byEA.get(eaId);
    const status = record?.status ?? "missing";
    return {
      eaId,
      status,
      isResponded: status === "confirmed" || status === "unavailable",
      openSlotCount: record ? buildInterviewSlots(record).length : 0,
    };
  });
}
