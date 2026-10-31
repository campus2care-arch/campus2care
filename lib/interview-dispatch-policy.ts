import { instantToEasternLocal } from "./interview-timezone";
import { mondayForDate } from "./interview-availability";
export type InterviewDispatchKind = "ea_request" | "ea_reminder" | "leadership_escalation" | "applicant_friday" | "applicant_sunday" | "applicant_monday";
const schedules: Array<{ day: number; minute: number; kind: InterviewDispatchKind }> = [
  { day:3, minute:15*60, kind:"ea_request" }, { day:4, minute:18*60, kind:"ea_reminder" },
  { day:5, minute:11*60, kind:"leadership_escalation" }, { day:5, minute:14*60, kind:"applicant_friday" },
  { day:0, minute:17*60, kind:"applicant_sunday" }, { day:1, minute:9*60, kind:"applicant_monday" },
];
/** One local-day key tolerates repeated scheduler calls and UTC offset changes. No late next-day blasts. */
export function dueInterviewDispatches(now: Date) {
  const local = instantToEasternLocal(now);
  const day = new Date(local.date + "T12:00:00Z").getUTCDay();
  return schedules.filter((item) => item.day === day && local.minute >= item.minute).map((item) => {
    const target = new Date(mondayForDate(local.date) + "T12:00:00Z");
    if (day !== 1) target.setUTCDate(target.getUTCDate() + 7);
    return { kind:item.kind, runKey:item.kind + ":" + local.date, weekStart:target.toISOString().slice(0,10) };
  });
}
export type RoutineAttempt = { state: string; sentAt: string | null; createdAt: string };
/** Follow-up frequency limits. 0 turns a limit off; unset keeps the original 48h / 2-per-week policy. */
export type OutreachFrequencyPolicy = { minSpacingHours: number; maxPerRollingWeek: number };
function limit(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  // A malformed value keeps the stricter default rather than silently disabling the limit.
  return Number.isInteger(value) && value >= 0 && value <= max ? value : fallback;
}
export function outreachFrequencyPolicy(env: Record<string, string | undefined> = process.env): OutreachFrequencyPolicy {
  return {
    minSpacingHours: limit(env.INTERVIEW_FOLLOWUP_MIN_SPACING_HOURS, 48, 24 * 30),
    maxPerRollingWeek: limit(env.INTERVIEW_FOLLOWUP_MAX_PER_7_DAYS, 2, 20),
  };
}
/** Hours of outreach history a caller must load to evaluate the policy. */
export function outreachHistoryLookbackHours(policy = outreachFrequencyPolicy()): number {
  return Math.max(7 * 24, policy.minSpacingHours);
}
/** Scope this history by recipient HMAC across both campuses, never by Notion page.
 * A founder frequency exception waives only the spacing and weekly limits; an
 * unresolved or uncertain prior send always blocks, so nothing is double-sent. */
export function routineOutreachDecision(history: RoutineAttempt[], now = Date.now(),
  policy: OutreachFrequencyPolicy = outreachFrequencyPolicy(),
  options: { frequencyException?: boolean } = {}): string {
  if (history.some((a) => ["queued","sending","reconcile_required"].includes(a.state))) return "unresolved_prior_message";
  if (options.frequencyException === true) return "eligible";
  const sent = history.filter((a) => a.state === "sent" && a.sentAt).map((a) => Date.parse(a.sentAt!));
  if (sent.some((at) => !Number.isFinite(at))) return "spacing_48_hours";
  if (policy.minSpacingHours > 0 && sent.some((at) => at > now - policy.minSpacingHours*3600000)) return "spacing_48_hours";
  if (policy.maxPerRollingWeek > 0 &&
      sent.filter((at) => at > now - 7*86400000).length >= policy.maxPerRollingWeek) return "rolling_week_limit";
  return "eligible";
}
