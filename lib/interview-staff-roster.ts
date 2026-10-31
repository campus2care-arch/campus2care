import type { Sql } from "postgres";
import { interviewStaffDatabase } from "./interview-staff-db";
import { buildInterviewSlots, type WeeklyConfirmation } from "./interview-availability";

export type Campus = "BU" | "BC";
export type TeamRole = "lead" | "shadow";
export type RosterInput = { name: string; email: string; campus: Campus; teamRole: TeamRole; leadEmail?: string | null };

const workspaceEmail = /^[a-z0-9._%+-]+@campus2care\.org$/;
const FOUNDER = "president@campus2care.org";
/** Leads get bookable capacity; the founder can change it later. Shadowers never host alone. */
export const DEFAULT_LEAD_WEEKLY_CAPACITY = 10;

export class RosterError extends Error { constructor(public readonly code: string) { super(code); } }

/** Pure validation. Interviewers sign in with Google Workspace, so only campus2care.org addresses work. */
export function validateRosterInput(raw: unknown): RosterInput {
  if (!raw || typeof raw !== "object") throw new RosterError("invalid_interviewer");
  const v = raw as Record<string, unknown>;
  const email = typeof v.email === "string" ? v.email.trim().toLowerCase() : "";
  const name = typeof v.name === "string" ? v.name.trim().replace(/\s+/g, " ") : "";
  const leadEmail = typeof v.leadEmail === "string" && v.leadEmail.trim() ? v.leadEmail.trim().toLowerCase() : null;
  if (!workspaceEmail.test(email)) throw new RosterError("interviewer_email_must_be_campus2care_org");
  if (name.length < 2 || name.length > 80) throw new RosterError("invalid_interviewer_name");
  if (v.campus !== "BU" && v.campus !== "BC") throw new RosterError("invalid_campus");
  if (v.teamRole !== "lead" && v.teamRole !== "shadow") throw new RosterError("invalid_team_role");
  if (leadEmail && (!workspaceEmail.test(leadEmail) || leadEmail === email)) throw new RosterError("invalid_lead_email");
  if (v.teamRole === "lead" && leadEmail) throw new RosterError("leads_have_no_lead");
  return { name, email, campus: v.campus, teamRole: v.teamRole, leadEmail };
}

/** One person per line: "Name, email, lead|shadow[, lead email]". Campus comes from the selector. */
export function parseRosterLines(text: string, campus: Campus): RosterInput[] {
  const rows = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (rows.length > 50) throw new RosterError("too_many_interviewers");
  return rows.map((line, index) => {
    const [name, email, role, leadEmail] = line.split(/[,\t]/).map((part) => part.trim());
    try {
      return validateRosterInput({ name, email, campus,
        teamRole: (role ?? "").toLowerCase().startsWith("shadow") ? "shadow" : "lead", leadEmail });
    } catch (error) {
      throw new RosterError("line_" + (index + 1) + ":" + (error instanceof RosterError ? error.code : "invalid"));
    }
  });
}

export type RosterRow = {
  id: string; name: string; email: string; campuses: Campus[]; teamRole: TeamRole; active: boolean;
  weeklyCapacity: number; leadId: string | null; leadName: string | null; invitedAt: string | null;
  weekStatus: "not_submitted" | "confirmed" | "unavailable" | "pending";
  confirmedAt: string | null; approvalSource: "ea" | "founder" | null; slotCount: number;
};

/** Roster with each person's submission state for one week. */
export async function readRosterWeek(weekStart: string, campus: Campus | "ALL", db: Sql = interviewStaffDatabase()): Promise<RosterRow[]> {
  const rows = await db<{ id: string; display_name: string; workspace_email: string; allowed_campuses: Campus[];
    team_role: TeamRole; active: boolean; weekly_capacity_limit: number; lead_interviewer_id: string | null;
    lead_name: string | null; invited_at: Date | null; status: string | null; confirmed_at: Date | null;
    approval_source: "ea" | "founder" | null; effective_windows: WeeklyConfirmation["recurringWindows"] | null;
    date_overrides: WeeklyConfirmation["overrides"] | null }[]>`
    SELECT i.id, i.display_name, lower(i.workspace_email) AS workspace_email, i.allowed_campuses, i.team_role, i.active,
      i.weekly_capacity_limit, i.lead_interviewer_id, l.display_name AS lead_name, i.invited_at,
      w.status, w.confirmed_at, w.approval_source, w.effective_windows, w.date_overrides
    FROM interview.interviewer i
    LEFT JOIN interview.interviewer l ON l.id = i.lead_interviewer_id
    LEFT JOIN interview.interviewer_week w ON w.interviewer_id = i.id AND w.week_start = ${weekStart}::date
    WHERE i.staff_access AND i.removed_at IS NULL
      AND (${campus} = 'ALL' OR ${campus} = ANY(i.allowed_campuses))
    ORDER BY i.allowed_campuses[1], i.team_role, i.display_name`;
  return rows.map((r) => {
    const status = r.status === "confirmed" || r.status === "unavailable" || r.status === "pending" ? r.status : "not_submitted";
    return { id: r.id, name: r.display_name, email: r.workspace_email, campuses: r.allowed_campuses, teamRole: r.team_role,
      active: r.active, weeklyCapacity: r.weekly_capacity_limit, leadId: r.lead_interviewer_id, leadName: r.lead_name,
      invitedAt: r.invited_at?.toISOString() ?? null, weekStatus: status as RosterRow["weekStatus"],
      confirmedAt: r.confirmed_at?.toISOString() ?? null, approvalSource: r.approval_source,
      slotCount: slotCount(r.workspace_email, weekStart, status, r.confirmed_at, r.effective_windows, r.date_overrides) };
  });
}

/** 20-minute slots the person offered, using the same generator as booking. */
function slotCount(email: string, weekStart: string, status: string, confirmedAt: Date | null,
  windows: WeeklyConfirmation["recurringWindows"] | null, overrides: WeeklyConfirmation["overrides"] | null): number {
  if (status !== "confirmed" || !confirmedAt) return 0;
  try {
    return buildInterviewSlots({ eaId: email, weekStart, status: "confirmed", confirmedAt: confirmedAt.toISOString(),
      recurringWindows: windows ?? [], overrides: overrides ?? [] }).length;
  } catch { return 0; }
}

/** Add or restore people. Existing availability, bookings and history are kept. */
export async function upsertRoster(people: RosterInput[], actor: string, db: Sql = interviewStaffDatabase()) {
  if (people.length < 1 || people.length > 50) throw new RosterError("too_many_interviewers");
  if (new Set(people.map((p) => p.email)).size !== people.length) throw new RosterError("duplicate_interviewer_email");
  return db.begin(async (tx) => {
    for (const p of people) {
      if (p.email === FOUNDER && p.teamRole !== "lead") throw new RosterError("founder_must_stay_lead");
      await tx`INSERT INTO interview.interviewer (workspace_email, display_name, active, allowed_campuses,
          weekly_capacity_limit, team_role, staff_access)
        VALUES (${p.email}, ${p.name}, ${p.teamRole === "lead"}, ${[p.campus]}::text[],
          ${p.teamRole === "lead" ? DEFAULT_LEAD_WEEKLY_CAPACITY : 0}, ${p.teamRole}, true)
        ON CONFLICT ((lower(workspace_email))) DO UPDATE SET display_name = EXCLUDED.display_name,
          allowed_campuses = EXCLUDED.allowed_campuses, team_role = EXCLUDED.team_role,
          active = EXCLUDED.active,
          weekly_capacity_limit = CASE WHEN EXCLUDED.team_role = 'lead'
            THEN GREATEST(interview.interviewer.weekly_capacity_limit, ${DEFAULT_LEAD_WEEKLY_CAPACITY}) ELSE 0 END,
          lead_interviewer_id = CASE WHEN EXCLUDED.team_role = 'lead' THEN NULL ELSE interview.interviewer.lead_interviewer_id END,
          staff_access = true, removed_at = NULL, updated_at = now()`;
    }
    for (const p of people.filter((x) => x.teamRole === "shadow")) {
      if (!p.leadEmail) {
        await tx`UPDATE interview.interviewer SET lead_interviewer_id = NULL WHERE lower(workspace_email) = ${p.email}`;
        continue;
      }
      const lead = await tx<{ id: string }[]>`SELECT id FROM interview.interviewer
        WHERE lower(workspace_email) = ${p.leadEmail} AND team_role = 'lead' AND staff_access AND removed_at IS NULL
          AND ${p.campus} = ANY(allowed_campuses)`;
      if (!lead[0]) throw new RosterError("lead_not_found_on_" + p.campus + ":" + p.leadEmail);
      await tx`UPDATE interview.interviewer SET lead_interviewer_id = ${lead[0].id} WHERE lower(workspace_email) = ${p.email}`;
    }
    await tx`INSERT INTO interview.audit_event (actor_ref, action, object_type, object_id, outcome, metadata)
      VALUES (${actor}, 'roster_upsert', 'interviewer', ${people.map((p) => p.email).join(",").slice(0, 500)}, 'saved',
        ${tx.json({ count: people.length, campuses: [...new Set(people.map((p) => p.campus))] })})`;
    return { saved: people.length };
  });
}

/** Removal revokes sign-in immediately; availability and interview history stay in Neon. */
export async function removeFromRoster(email: string, actor: string, db: Sql = interviewStaffDatabase()) {
  const normalized = email.trim().toLowerCase();
  if (normalized === FOUNDER) throw new RosterError("founder_cannot_be_removed");
  return db.begin(async (tx) => {
    const rows = await tx<{ id: string }[]>`UPDATE interview.interviewer SET staff_access = false, removed_at = now(),
        active = false, updated_at = now()
      WHERE lower(workspace_email) = ${normalized} AND removed_at IS NULL RETURNING id`;
    if (!rows[0]) throw new RosterError("interviewer_not_found");
    await tx`UPDATE interview.interviewer SET lead_interviewer_id = NULL WHERE lead_interviewer_id = ${rows[0].id}`;
    await tx`INSERT INTO interview.audit_event (actor_ref, action, object_type, object_id, outcome, metadata)
      VALUES (${actor}, 'roster_remove', 'interviewer', ${rows[0].id}, 'removed', ${tx.json({})})`;
    return { removed: true };
  });
}

export async function markRosterInvited(emails: string[], db: Sql = interviewStaffDatabase()) {
  const list = emails.map((e) => e.trim().toLowerCase()).filter((e) => workspaceEmail.test(e)).slice(0, 100);
  const rows = await db`UPDATE interview.interviewer SET invited_at = now()
    WHERE lower(workspace_email) = ANY(${list}::text[]) AND staff_access AND removed_at IS NULL RETURNING id`;
  return { marked: rows.length };
}
