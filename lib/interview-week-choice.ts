import { mondayForDate } from "./interview-availability";

/** Week choices are based on Boston civil dates, not a browser's local timezone. */
export function interviewWeekChoices(now: Date = new Date()): { current: string; next: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const value = (name: string) => parts.find(part => part.type === name)?.value ?? "";
  const current = mondayForDate(value("year") + "-" + value("month") + "-" + value("day"));
  const nextDate = new Date(current + "T00:00:00Z");
  nextDate.setUTCDate(nextDate.getUTCDate() + 7);
  return { current, next: nextDate.toISOString().slice(0, 10) };
}

/** Requires a deliberate acknowledgement on every current-week confirmation.
 * Caller must still validate the week, identity, roster and permissions.
 */
export function needsCurrentWeekAcknowledgement(
  weekStart: string, now: Date = new Date(),
): boolean {
  return weekStart === interviewWeekChoices(now).current;
}
