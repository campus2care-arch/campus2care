import type { Sql, TransactionSql } from "postgres";
import { buildInterviewSlots, type WeeklyConfirmation } from "./interview-availability";
import { instantToEasternLocal } from "./interview-timezone";

export type InterviewParticipant = { id: string; email: string; name: string; role: "lead" | "shadow"; available: boolean };
export type InterviewTeam = { id: string; revision: string; approvedBy: string | null; campus: string; leadId: string; startsAt: string; participants: InterviewParticipant[] };

/** Explicit assignments are independent of a person's permission to host alone. */
export async function readInterviewTeams(db: Sql | TransactionSql): Promise<InterviewTeam[]> {
  const rows = await db<{
    id: string; revision: string; approved_by: string | null; campus: string; lead_id: string; starts_at: Date; participant_id: string;
    workspace_email: string; display_name: string; role: "lead" | "shadow";
    removed_at?: Date | null; staff_access?: boolean | null;
    status: WeeklyConfirmation["status"] | null; confirmed_at: Date | null;
    effective_windows: WeeklyConfirmation["recurringWindows"] | null;
    date_overrides: WeeklyConfirmation["overrides"] | null;
  }[]>`SELECT s.id,s.revision::text AS revision,s.approved_by,s.campus,s.lead_id,s.starts_at,p.participant_id,i.workspace_email,i.display_name,p.role,i.removed_at,i.staff_access,
      w.status,w.confirmed_at,w.effective_windows,w.date_overrides
    FROM interview.schedule_slot s
    JOIN interview.schedule_participant p ON p.slot_id=s.id
    JOIN interview.interviewer i ON i.id=p.participant_id
    LEFT JOIN interview.interviewer_week w ON w.interviewer_id=i.id
      AND w.week_start=date_trunc('week',s.starts_at AT TIME ZONE 'America/New_York')::date
    WHERE s.starts_at>now()-interval '1 day' AND s.starts_at<now()+interval '40 days'
    ORDER BY s.starts_at,s.lead_id,p.role,i.workspace_email`;
  const teams = new Map<string, InterviewTeam>();
  for (const row of rows) {
    const startsAt = row.starts_at.toISOString(), key = row.lead_id + ":" + startsAt;
    const local = instantToEasternLocal(row.starts_at);
    const monday = new Date(local.date + "T00:00:00Z");
    monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
    // Removed staff or revoked sign-in never count toward an offered team, even on approved slots.
    const rostered = !row.removed_at && row.staff_access !== false;
    const available = rostered && (row.approved_by === "president@campus2care.org" || !!row.confirmed_at && row.status === "confirmed" && buildInterviewSlots({
      eaId: row.workspace_email, weekStart: monday.toISOString().slice(0, 10), status: row.status,
      confirmedAt: row.confirmed_at.toISOString(), recurringWindows: row.effective_windows ?? [], overrides: row.date_overrides ?? [],
    }).some(slot => slot.date === local.date && slot.startMinute === local.minute));
    const team = teams.get(key) ?? { id: row.id, revision: row.revision, approvedBy: row.approved_by, campus: row.campus, leadId: row.lead_id, startsAt, participants: [] };
    team.participants.push({ id: row.participant_id, email: row.workspace_email, name: row.display_name, role: row.role, available });
    teams.set(key, team);
  }
  return [...teams.values()];
}

export function teamForSlot(teams: InterviewTeam[], leadId: string, startsAt: string, campus: string) {
  return teams.find(team => team.leadId === leadId && team.startsAt === startsAt && team.campus === campus);
}

/** Serialize a shadower's withdrawal against an in-flight booking. */
export async function lockInterviewTeamWeeks(db: TransactionSql, leadId: string, startsAt: string) {
  await db`SELECT w.interviewer_id FROM interview.interviewer_week w
    JOIN interview.schedule_participant p ON p.participant_id=w.interviewer_id
    JOIN interview.schedule_slot s ON s.id=p.slot_id
    WHERE s.lead_id=${leadId} AND s.starts_at=${startsAt}::timestamptz
      AND w.week_start=date_trunc('week',s.starts_at AT TIME ZONE 'America/New_York')::date
    ORDER BY w.interviewer_id FOR SHARE OF w`;
}

export async function interviewTeamDescription(db: Sql | TransactionSql, leadId: string, startsAt: string, campus: string): Promise<string | undefined> {
  const team=teamForSlot(await readInterviewTeams(db),leadId,startsAt,campus);
  return team ? team.participants.map(p => (p.role === "lead" ? "Interview lead: " : "Shadowing: ") + p.name).join("\n") : undefined;
}
