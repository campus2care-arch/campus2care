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
/** Scope this history by recipient HMAC across both campuses, never by Notion page. */
export function routineOutreachDecision(history: RoutineAttempt[], now = Date.now()): string {
  if (history.some((a) => ["queued","sending","reconcile_required"].includes(a.state))) return "unresolved_prior_message";
  const sent = history.filter((a) => a.state === "sent" && a.sentAt).map((a) => Date.parse(a.sentAt!));
  if (sent.some((at) => !Number.isFinite(at) || at > now - 48*3600000)) return "spacing_48_hours";
  if (sent.filter((at) => at > now - 7*86400000).length >= 2) return "rolling_week_limit";
  return "eligible";
}
