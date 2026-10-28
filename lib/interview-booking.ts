import { createHash, randomUUID } from "node:crypto";
import { interviewDatabase, postgresConflictCode, requireInterviewStagingBooking } from "./interview-db";
import { buildInterviewSlots, mondayForDate, type WeeklyConfirmation } from "./interview-availability";
import { easternLocalToInstant, instantToEasternLocal } from "./interview-timezone";

import { calendarReadAccessEnabled,readInterviewerFreeBusy,calendarSlotIsFree } from "./interview-calendar-freebusy";
import { googleProviderAccessToken } from "./interview-google-provider-auth";
import { sealInterviewSecret } from "./interview-secrets";

export class InterviewBookingError extends Error {
  constructor(public readonly code: string, public readonly status = 400) {
    super(code);
    this.name = "InterviewBookingError";
  }
}

export type HoldRequest = {
  invitationToken: string;
  interviewerId: string;
  startsAt: string;
};

export type BookingHold = {
  id: string;
  status: "calendar_pending";
  startsAt: string;
  endsAt: string;
  timeZone: "America/New_York";
};

/**
 * Phase B: transactional synthetic-only staging holds.
 *
 * Until Notion eligibility, applicant email verification and Google Calendar
 * reconciliation are integrated, this service intentionally refuses all real
 * applicant records. Never expose it to production or call it from live outreach.
 */
export async function createStagingInterviewHold(input: HoldRequest): Promise<BookingHold> {
  requireInterviewStagingBooking();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(input.invitationToken ?? "") ||
      !/^[0-9a-f-]{36}$/i.test(input.interviewerId ?? "") ||
      typeof input.startsAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input.startsAt)) {
    throw new InterviewBookingError("invalid_booking_request");
  }

  const startsAt = new Date(input.startsAt);
  if (Number.isNaN(startsAt.getTime())) throw new InterviewBookingError("invalid_booking_time");
  const local = instantToEasternLocal(startsAt);
  const weekStart = mondayForDate(local.date);
  if (startsAt.getTime() < Date.now() + 30 * 60000) throw new InterviewBookingError("booking_in_past");

  const tokenHash = createHash("sha256").update(input.invitationToken).digest("hex");
  const db = interviewDatabase();

  try {
    return await db.begin(async (tx): Promise<BookingHold> => {
      // Locks serialize parallel requests that use the same invitation.
      const inviteRows = await tx<{
        id: string; campus: "BU" | "BC"; notion_page_id: string;
        recipient_hmac: string;
      }[]>`
        SELECT id, campus, notion_page_id, recipient_hmac
        FROM interview.invitation
        WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
          AND expires_at > now() AND email_verified_at IS NOT NULL
        FOR UPDATE
      `;
      const invitation = inviteRows[0];
      if (!invitation) throw new InterviewBookingError("invalid_or_unverified_invitation", 403);

      // The real Notion eligibility read is not yet authorized; do not fake it.
      if (!invitation.notion_page_id.startsWith("synthetic-")) {
        throw new InterviewBookingError("live_applicant_verification_not_ready", 503);
      }

      const interviewerRows = await tx<{
        id: string; workspace_email: string; active: boolean;
        allowed_campuses: string[]; weekly_capacity_limit: number;
      }[]>`
        SELECT id, workspace_email, active, allowed_campuses, weekly_capacity_limit
        FROM interview.interviewer
        WHERE id = ${input.interviewerId}
        FOR UPDATE
      `;
      const interviewer = interviewerRows[0];
      if (!interviewer?.active || !interviewer.allowed_campuses.includes(invitation.campus) ||
          interviewer.weekly_capacity_limit < 1) {
        throw new InterviewBookingError("interviewer_unavailable", 409);
      }

      const weekRows = await tx<{
        status: "pending" | "confirmed" | "unavailable";
        confirmed_at: Date | null;
        effective_windows: WeeklyConfirmation["recurringWindows"];
        date_overrides: WeeklyConfirmation["overrides"];
      }[]>`
        SELECT status, confirmed_at, effective_windows, date_overrides
        FROM interview.interviewer_week
        WHERE interviewer_id = ${interviewer.id} AND week_start = ${weekStart}::date
        FOR UPDATE
      `;
      const week = weekRows[0];
      if (!week || week.status !== "confirmed" || !week.confirmed_at) {
        throw new InterviewBookingError("availability_not_confirmed", 409);
      }

      const record: WeeklyConfirmation = {
        eaId: interviewer.workspace_email,
        weekStart, status: "confirmed",
        confirmedAt: week.confirmed_at.toISOString(),
        recurringWindows: week.effective_windows,
        overrides: week.date_overrides,
      };
      const slots = buildInterviewSlots(record);
      const requestedSlot = slots.find((s) =>
        s.date === local.date && s.startMinute === local.minute);
      if (!requestedSlot) throw new InterviewBookingError("slot_not_in_confirmed_availability", 409);
      // Reject ambiguous/nonexistent wall times during DST transitions.
      const checkedInstant = easternLocalToInstant(local.date, local.minute);
      if (checkedInstant.getTime() !== startsAt.getTime()) {
        throw new InterviewBookingError("invalid_booking_time", 400);
      }

      const weekEnd = new Date(weekStart + "T00:00:00Z");
      weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
      const countRows = await tx<{ booked: number }[]>`
        SELECT count(*)::int AS booked FROM interview.reservation
        WHERE interviewer_id = ${interviewer.id}
          AND (starts_at AT TIME ZONE 'America/New_York') >= ${weekStart}::date
          AND (starts_at AT TIME ZONE 'America/New_York') < ${weekEnd.toISOString().slice(0, 10)}::date
          AND status IN ('held','calendar_pending','confirmed',
            'reschedule_pending','cancel_pending','reconcile_required')
      `;
      if ((countRows[0]?.booked ?? 0) >= interviewer.weekly_capacity_limit) {
        throw new InterviewBookingError("interviewer_capacity_reached", 409);
      }

      if(calendarReadAccessEnabled()) {
        const busy=await readInterviewerFreeBusy({calendarId:interviewer.workspace_email,
          accessToken:await googleProviderAccessToken("calendar"),startsAt:startsAt.toISOString(),
          endsAt:new Date(startsAt.getTime()+25*60000).toISOString()});
        if(!calendarSlotIsFree(startsAt.toISOString(),new Date(startsAt.getTime()+20*60000).toISOString(),busy)) {
          throw new InterviewBookingError("slot_conflicts_with_calendar",409);
        }
      }
      const id = randomUUID();
      const endsAt = new Date(startsAt.getTime() + 20 * 60000);
      const blocksUntil = new Date(endsAt.getTime() + 5 * 60000);
      await tx`UPDATE interview.invitation SET management_token=${tx.json(sealInterviewSecret(input.invitationToken,"invitation:"+invitation.id))},
        expires_at=GREATEST(expires_at,${new Date(endsAt.getTime()+2*86400000).toISOString()}::timestamptz) WHERE id=${invitation.id}`;
      await tx`
        INSERT INTO interview.reservation
          (id, invitation_id, campus, notion_page_id, recipient_hmac, interviewer_id,
           starts_at, ends_at, blocks_until, status)
        VALUES
          (${id}, ${invitation.id}, ${invitation.campus}, ${invitation.notion_page_id},
           ${invitation.recipient_hmac}, ${interviewer.id}, ${startsAt.toISOString()},
           ${endsAt.toISOString()}, ${blocksUntil.toISOString()}, 'calendar_pending')
      `;
      // The outbox is committed atomically with the hold. No external API call
      // happens here; future workers must use idempotent/reconcilable operations.
      await tx`
        INSERT INTO interview.integration_outbox
          (operation_key, provider, action, object_id)
        VALUES (${"interview-calendar:create:" + id}, 'google_calendar', 'create_event', ${id})
      `;
      return {
        id, status: "calendar_pending", startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(), timeZone: "America/New_York",
      };
    });
  } catch (error) {
    if (error instanceof InterviewBookingError) throw error;
    const conflict = postgresConflictCode(error);
    if (conflict) throw new InterviewBookingError(conflict, 409);
    throw error;
  }
}
