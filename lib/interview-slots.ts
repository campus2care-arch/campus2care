import { readInterviewTeams, teamForSlot } from "./interview-teams";
import { interviewBufferForWeek } from "./interview-week-policy";
import { createHash } from "node:crypto";
import { interviewDatabase, requireInterviewStagingBooking } from "./interview-db";
import { buildInterviewSlots, type WeeklyConfirmation, mondayForDate } from "./interview-availability";
import { easternLocalToInstant, instantToEasternLocal } from "./interview-timezone";
import { InterviewBookingError } from "./interview-booking";

export type PublicInterviewSlot = {
  interviewerId: string;
  interviewerName: string;
  shadowNames: string[];
  startsAt: string;
  endsAt: string;
  timeZone: "America/New_York";
};

/**
 * Candidate-slot discovery from confirmed DB schedules, never from private
 * staff template drafts. Staging is restricted to synthetic, preverified
 * invitations until real Notion eligibility and email verification exist.
 */
export async function listStagingInterviewSlots(invitationToken: string, reservationId?:string): Promise<PublicInterviewSlot[]> {
  requireInterviewStagingBooking();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(invitationToken ?? "")) {
    throw new InterviewBookingError("invalid_invitation", 403);
  }
  const db = interviewDatabase();
  const hash = createHash("sha256").update(invitationToken).digest("hex");
  const invites = await db<{ id:string;campus: "BU" | "BC"; notion_page_id: string }[]>`
    SELECT id,campus, notion_page_id FROM interview.invitation
    WHERE token_hash = ${hash} AND revoked_at IS NULL
      AND expires_at > now() AND email_verified_at IS NOT NULL
    LIMIT 1
  `;
  const invitation = invites[0];
  if (!invitation) throw new InterviewBookingError("invalid_or_unverified_invitation", 403);
  if (!invitation.notion_page_id.startsWith("synthetic-")) {
    throw new InterviewBookingError("live_applicant_verification_not_ready", 503);
  }

  if(reservationId){
    if(!/^[a-f0-9-]{36}$/i.test(reservationId))throw new InterviewBookingError("invalid_reschedule_request");
    const original=await db`SELECT id FROM interview.reservation WHERE id=${reservationId} AND invitation_id=${invitation.id} AND status='confirmed'`;
    if(!original.length)throw new InterviewBookingError("reschedule_requires_confirmed_booking",409);
  }
  const rows = await db<{
    interviewer_id: string;
    week_start: string;
    workspace_email: string;
    display_name: string;
    weekly_capacity_limit: number;
    confirmed_at: Date;
    effective_windows: WeeklyConfirmation["recurringWindows"];
    date_overrides: WeeklyConfirmation["overrides"];
  }[]>`
    SELECT i.id AS interviewer_id, to_char(w.week_start, 'YYYY-MM-DD') AS week_start,
      i.workspace_email, i.display_name, i.weekly_capacity_limit, w.confirmed_at,
      w.effective_windows, w.date_overrides
    FROM interview.interviewer i
    JOIN interview.interviewer_week w ON w.interviewer_id = i.id
    WHERE i.active AND i.weekly_capacity_limit > 0 AND w.status = 'confirmed'
      AND w.confirmed_at IS NOT NULL
      AND ${invitation.campus} = ANY(i.allowed_campuses)
      AND w.week_start >= ((now() AT TIME ZONE 'America/New_York')::date - 7)
      AND w.week_start < ((now() AT TIME ZONE 'America/New_York')::date + 35)
    ORDER BY w.week_start, i.id
    LIMIT 120
  `;
  if (rows.length === 0) return [];

  const busyRows = await db<{
    claim_key:string;interviewer_id: string; starts_at: Date; blocks_until: Date;
  }[]>`
    SELECT claim_key,interviewer_id, starts_at, blocks_until
    FROM interview.slot_claim
    WHERE starts_at < now() + interval '40 days'
      AND blocks_until > now() - interval '1 day'
    LIMIT 5000
  `;

  const byEa = new Map<string, Array<{ key:string;start: number; end: number; week: string }>>();
  for (const busy of busyRows) {
    const list = byEa.get(busy.interviewer_id) ?? [];
    const local = instantToEasternLocal(busy.starts_at);
    list.push({ key:busy.claim_key,start: busy.starts_at.getTime(), end: busy.blocks_until.getTime(),
      week: mondayForDate(local.date) });
    byEa.set(busy.interviewer_id, list);
  }
  const teams = await readInterviewTeams(db);
  const slots: PublicInterviewSlot[] = [];
  const now = Date.now();
  for (const row of rows) {
    const booked = (byEa.get(row.interviewer_id) ?? [])
      .filter((x) => x.week === row.week_start);
    if (booked.filter(x=>x.key!=="reservation:"+reservationId).length >= row.weekly_capacity_limit) continue;
    const week: WeeklyConfirmation = {
      eaId: row.workspace_email, weekStart: row.week_start, status: "confirmed",
      confirmedAt: row.confirmed_at.toISOString(),
      recurringWindows: row.effective_windows, overrides: row.date_overrides,
    };
    for (const slot of buildInterviewSlots(week)) {
      try {
        const start = easternLocalToInstant(slot.date, slot.startMinute);
        const end = new Date(start.getTime() + 20 * 60000);
        const team = teamForSlot(teams, row.interviewer_id, start.toISOString(), invitation.campus);
        if (row.week_start === "2026-11-02" && (!team || team.participants.some(p => !p.available))) continue;
        const teamBusy = (team?.participants ?? []).flatMap(p => byEa.get(p.id) ?? []);
        const blockEnd = end.getTime() + interviewBufferForWeek(row.week_start) * 60000;
        if (start.getTime() < now + 30 * 60000 ||
            [...booked, ...teamBusy].some((x) => !x.key.startsWith("reservation:" + reservationId) && start.getTime() < x.end && x.start < blockEnd)) continue;
        slots.push({ interviewerId: row.interviewer_id, interviewerName: row.display_name, shadowNames: team?.participants.filter(p => p.role === "shadow").map(p => p.name) ?? [],
          startsAt: start.toISOString(), endsAt: end.toISOString(),
          timeZone: "America/New_York" });
      } catch (error) {
        if (error instanceof Error && error.message === "ambiguous_or_nonexistent_local_time") continue;
        throw error;
      }
    }
  }
  // Multiple interviewers can legitimately offer the same start time.
  return slots.sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .slice(0, 80);
}
