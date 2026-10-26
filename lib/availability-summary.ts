const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// The public grids submit explicit half-hour blocks between 7am and 10pm.
export function availabilitySummary(days: Record<string, string>) {
  let total = 0;
  let longest = 0;
  const minute = (hour: string, minutes: string | undefined, meridiem: string) =>
    (Number(hour) % 12 + (meridiem.toLowerCase() === "pm" ? 12 : 0)) * 60 + Number(minutes ?? 0);
  for (const [index, day] of DAYS.entries()) {
    const value = days[day].trim();
    if (/^(unavailable|not available)$/i.test(value)) continue;
    let endOfPrevious = 0;
    for (const block of value.split(",")) {
      const match = block.trim().match(/^(1[0-2]|[1-9])(?::(00|30))?\s*(am|pm)\s*[–—-]\s*(1[0-2]|[1-9])(?::(00|30))?\s*(am|pm)$/i);
      if (!match) return null;
      const start = minute(match[1], match[2], match[3]);
      const end = minute(match[4], match[5], match[6]);
      if (start < 420 || end > 1320 || end <= start || start < endOfPrevious) return null;
      total += end - start;
      if (index < 5) longest = Math.max(longest, end - start);
      endOfPrevious = end;
    }
  }
  if (!total) return null;
  return { totalHours: total / 60, longestWeekdayBlockHours: longest / 60, meetsWeekdayBlock: longest >= 180 };
}
