import {
  dateInWeek, mondayForDate, type DateOverride, type TimeWindow, type WeeklyConfirmation, type WeeklyWindows,
} from "./interview-availability";

export type StandingSource = "unavailable" | "week" | "template" | "none";

export type StoredStandingWeek = {
  status: WeeklyConfirmation["status"] | null;
  recurringWindows: WeeklyWindows[] | null;
  overrides: DateOverride[] | null;
  confirmedAt: string | null;
};

/** How many Mondays a save carries forward, covering the staff week picker and the booking window. */
export const STANDING_WEEK_COUNT = 6;

export function windowsByWeekday(rows: WeeklyWindows[] | null | undefined): WeeklyWindows[] {
  const days: TimeWindow[][] = [[], [], [], [], [], [], []];
  for (const day of rows ?? []) {
    if (!Number.isInteger(day.weekday) || day.weekday < 0 || day.weekday > 6) continue;
    days[day.weekday] = (day.windows ?? []).map((window) => ({ ...window }));
  }
  return days.map((windows, weekday) => ({ weekday, windows }));
}

export function weekdaysHaveHours(rows: WeeklyWindows[] | null | undefined): boolean {
  return (rows ?? []).some((day) => (day.windows ?? []).some((window) => window.endMinute > window.startMinute));
}

export function overridesHaveHours(overrides: DateOverride[] | null | undefined): boolean {
  return (overrides ?? []).some((override) =>
    override.kind === "replace" && (override.windows ?? []).some((window) => window.endMinute > window.startMinute));
}

/** Date overrides win for that civil date. Other days keep the weekday windows. */
export function projectWeek(
  weekStart: string, recurring: WeeklyWindows[] | null | undefined, overrides: DateOverride[] | null | undefined,
): WeeklyWindows[] {
  const days = windowsByWeekday(recurring);
  for (const override of overrides ?? []) {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      if (dateInWeek(weekStart, weekday) !== override.date) continue;
      days[weekday] = {
        weekday,
        windows: override.kind === "unavailable" ? [] : (override.windows ?? []).map((window) => ({ ...window })),
      };
    }
  }
  return days;
}

/**
 * Hours the scheduler and the availability page both use.
 * An explicit "no interviews" week stays empty. A missing week, or a confirmed
 * week whose stored windows are blank, uses the recurring template. A confirmed
 * week that only put hours in date overrides still counts those hours.
 */
export function resolveStandingWindows(
  weekStart: string, week: StoredStandingWeek | null, template: { recurringWindows: WeeklyWindows[] } | null,
): { windows: WeeklyWindows[]; source: StandingSource } {
  if (week?.status === "unavailable") return { windows: windowsByWeekday([]), source: "unavailable" };
  if (week?.status === "confirmed") {
    const projected = projectWeek(weekStart, week.recurringWindows, week.overrides);
    if (weekdaysHaveHours(projected)) return { windows: projected, source: "week" };
  }
  const standing = windowsByWeekday(template?.recurringWindows);
  if (weekdaysHaveHours(standing)) return { windows: standing, source: "template" };
  return { windows: windowsByWeekday([]), source: "none" };
}

/**
 * The hours on the screen are the standing schedule. Confirming must not store
 * seven empty days and hide the edits in one-week date overrides.
 */
export function persistedHoursFromEditor(edited: WeeklyWindows[]): {
  recurringWindows: WeeklyWindows[]; overrides: DateOverride[];
} {
  return { recurringWindows: windowsByWeekday(edited), overrides: [] };
}

/**
 * Old clients confirmed the untouched base week and sent edits only as overrides.
 * Fold that shape into weekday windows so the stored week matches the page.
 */
export function confirmationToStore(record: WeeklyConfirmation): WeeklyConfirmation {
  const recurring = windowsByWeekday(record.recurringWindows);
  if (record.status === "confirmed" && !weekdaysHaveHours(recurring) && overridesHaveHours(record.overrides)) {
    return { ...record, recurringWindows: projectWeek(record.weekStart, recurring, record.overrides), overrides: [] };
  }
  return { ...record, recurringWindows: recurring };
}

export function standingWeekStarts(fromMonday: string, count = STANDING_WEEK_COUNT): string[] {
  if (mondayForDate(fromMonday) !== fromMonday) throw new Error("week_must_start_monday");
  if (!Number.isInteger(count) || count < 1 || count > 12) throw new Error("invalid_week_horizon");
  const weeks: string[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    const day = new Date(fromMonday + "T00:00:00.000Z");
    day.setUTCDate(day.getUTCDate() + offset * 7);
    weeks.push(day.toISOString().slice(0, 10));
  }
  return weeks;
}
