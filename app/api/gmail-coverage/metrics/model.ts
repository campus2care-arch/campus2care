export const TIME_ZONE = "America/New_York";
export type Shift = { id: string; archived?: boolean; is_archived?: boolean; in_trash?: boolean; properties?: {
  "Daily Check"?: { title?: { plain_text?: string }[] };
  Date?: { date?: { start?: string; end?: string | null } | null };
  "Coverage Status"?: { select?: { name?: string } | null };
  Primary?: { select?: { name?: string } | null };
} };

export function easternDay(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
}
export function weekAt(now: Date) {
  const day = new Date(easternDay(now) + "T00:00:00Z");
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  const weekStart = day.toISOString().slice(0, 10);
  day.setUTCDate(day.getUTCDate() + 6);
  return { weekStart, weekEnd: day.toISOString().slice(0, 10), timeZone: TIME_ZONE };
}
function dateOf(value?: string): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(value + "T00:00:00Z");
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
  }
  // Notion timestamps carry an explicit offset. Never use the host's local zone.
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? easternDay(parsed) : null;
}
export function coverage(shifts: Shift[], now: Date) {
  const week = weekAt(now);
  let openShifts = 0, scheduledShifts = 0, reviewNeeded = 0, undatedRecords = 0;
  const seen = new Set<string>();
  for (const shift of shifts) {
    if (shift.archived || shift.is_archived || shift.in_trash || seen.has(shift.id)) continue;
    seen.add(shift.id);
    const p = shift.properties ?? {};
    if (!(p["Daily Check"]?.title ?? []).some(part => part.plain_text?.trim())) continue;
    const day = dateOf(p.Date?.date?.start);
    if (!day) { undatedRecords += 1; continue; }
    if (day < week.weekStart || day > week.weekEnd) continue;
    const status = p["Coverage Status"]?.select?.name;
    const owner = p.Primary?.select?.name?.trim();
    if (status === "Open") openShifts += 1;
    else if ((status === "Scheduled" || status === "Completed") && owner && !/^(unassigned|none|tbd)$/i.test(owner)) scheduledShifts += 1;
    else reviewNeeded += 1;
  }
  return { openShifts, scheduledShifts, reviewNeeded, undatedRecords, ...week, updatedAt: now.toISOString() };
}
