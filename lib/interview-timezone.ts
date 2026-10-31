/**
 * America/New_York civil-time conversion for the interview scheduler.
 * A local time in the DST gap or fold is rejected, rather than silently
 * assigning the wrong hour to a student or interviewer.
 */
const zone = "America/New_York";

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function nyParts(date: Date) {
  const parts = formatter.formatToParts(date);
  const value = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { date: value("year") + "-" + value("month") + "-" + value("day"),
    minute: Number(value("hour")) * 60 + Number(value("minute")) };
}

export function easternLocalToInstant(date: string, minute: number): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isInteger(minute) || minute < 0 || minute >= 1440) {
    throw new Error("invalid_local_interview_time");
  }
  const midnight = Date.parse(date + "T00:00:00.000Z");
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date) {
    throw new Error("invalid_local_interview_date");
  }
  const base = midnight + minute * 60000;
  // New York has UTC-4 or UTC-5 throughout the supported scheduling calendar.
  const candidates = [4, 5].map((offset) => new Date(base + offset * 3600000))
    .filter((instant) => {
      const local = nyParts(instant);
      return local.date === date && local.minute === minute;
    });
  if (candidates.length !== 1) throw new Error("ambiguous_or_nonexistent_local_time");
  return candidates[0];
}

export function instantToEasternLocal(instant: Date): { date: string; minute: number } {
  if (Number.isNaN(instant.getTime())) throw new Error("invalid_interview_instant");
  return nyParts(instant);
}
