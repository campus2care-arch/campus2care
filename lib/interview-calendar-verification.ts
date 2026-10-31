import { setTimeout as pause } from "node:timers/promises";
import {
  createSyntheticInterviewCalendarEvent, readSyntheticInterviewCalendarEvent,
  cancelSyntheticInterviewCalendarEvent, InterviewCalendarProviderError,
} from "./interview-calendar-provider";

export type CalendarVerification = {
  idempotent: boolean; meetReady: boolean; canceled: boolean; errorCode: string | null;
};
export async function cleanUpSyntheticCalendarEvent(
  accessToken: string, operationKey: string, transport: typeof fetch = fetch,
): Promise<boolean> {
  await cancelSyntheticInterviewCalendarEvent(accessToken, operationKey, transport);
  const event = await readSyntheticInterviewCalendarEvent(accessToken, operationKey, transport);
  return !event || ["cancelled", "canceled"].includes(event.status);
}
/** No attendees or messages. Cleanup is attempted even after an ambiguous create. */
export async function verifySyntheticCalendarLifecycle(
  input: { accessToken: string; operationKey: string; startsAt: string; endsAt: string },
  transport: typeof fetch = fetch,
  progress: (result: CalendarVerification) => Promise<void> = async () => undefined,
  wait: (milliseconds: number) => Promise<unknown> = pause,
): Promise<CalendarVerification> {
  const result: CalendarVerification = { idempotent: false, meetReady: false, canceled: false, errorCode: null };
  try {
    const event = await createSyntheticInterviewCalendarEvent(input, transport);
    const repeated = await createSyntheticInterviewCalendarEvent(input, transport);
    result.idempotent = event.id === repeated.id;
    let observed = repeated;
    for (let attempt = 0; attempt < 5 && !observed.meetUrl; attempt++) {
      await wait(1000);
      const refreshed = await readSyntheticInterviewCalendarEvent(input.accessToken, input.operationKey, transport);
      if (!refreshed) throw new Error("synthetic_calendar_event_missing");
      observed = refreshed;
    }
    result.meetReady = !!observed.meetUrl;
    if (!result.meetReady) result.errorCode = "synthetic_meet_not_ready";
    if (!result.idempotent) result.errorCode = "synthetic_idempotency_failed";
    await progress(result);
  } catch (error) {
    result.errorCode = error instanceof InterviewCalendarProviderError ? error.code : "synthetic_calendar_check_failed";
  } finally {
    try { result.canceled = await cleanUpSyntheticCalendarEvent(input.accessToken, input.operationKey, transport); }
    catch { result.canceled = false; }
    if (!result.canceled) result.errorCode = "synthetic_calendar_cleanup_required";
  }
  return result;
}
