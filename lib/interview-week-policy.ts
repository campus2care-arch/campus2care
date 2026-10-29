/** President-approved exception for the exact November 2–8, 2026 sheet. */
export function interviewBufferForWeek(weekStart: string): number {
  return weekStart === "2026-11-02" ? 0 : 5;
}
