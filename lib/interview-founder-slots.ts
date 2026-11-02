import type { Sql } from "postgres";
import { interviewStaffDatabase } from "./interview-staff-db";
import { buildInterviewSlots, mondayForDate, type WeeklyConfirmation } from "./interview-availability";
import { easternLocalToInstant, instantToEasternLocal } from "./interview-timezone";

export type Campus = "BU" | "BC";
export type SlotStatus = "booked" | "open" | "blocked";
export type TimetableSlot = {
  id: string; campus: Campus; startsAt: string; date: string; minute: number;
  lead: string; shadowers: string[]; status: SlotStatus; reason: string | null;
};
export class SlotError extends Error { constructor(public readonly code: string) { super(code); } }

const ACTIVE = ["held", "calendar_pending", "confirmed", "reschedule_pending", "cancel_pending", "reconcile_required"];

function validWeek(weekStart: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || mondayForDate(weekStart) !== weekStart) throw new SlotError("invalid_week");
}

/** Every approved 20-minute slot for one campus and week, with its team and booking state. */
export async function readSlotTimetable(campus: Campus | "ALL", weekStart: string,
  db: Sql = interviewStaffDatabase()): Promise<TimetableSlot[]> {
  validWeek(weekStart);
  const from = easternLocalToInstant(weekStart, 0).toISOString();
  const next = new Date(weekStart + "T12:00:00Z"); next.setUTCDate(next.getUTCDate() + 7);
  const to = easternLocalToInstant(next.toISOString().slice(0, 10), 0).toISOString();
  const rows = await db<{ id: string; campus: Campus; starts_at: Date; lead: string; lead_active: boolean;
    shadowers: string[] | null; booked: boolean; claimed: boolean }[]>`
    SELECT s.id, s.campus, s.starts_at, l.display_name AS lead, (l.active AND l.weekly_capacity_limit > 0
        AND s.campus = ANY(l.allowed_campuses) AND l.removed_at IS NULL) AS lead_active,
      (SELECT array_agg(i.display_name ORDER BY i.display_name) FROM interview.schedule_participant p
        JOIN interview.interviewer i ON i.id = p.participant_id WHERE p.slot_id = s.id AND p.role = 'shadow') AS shadowers,
      EXISTS (SELECT 1 FROM interview.reservation r WHERE r.interviewer_id = s.lead_id AND r.starts_at = s.starts_at
        AND r.status = ANY(${ACTIVE}::text[])) AS booked,
      EXISTS (SELECT 1 FROM interview.schedule_participant p JOIN interview.slot_claim c ON c.interviewer_id = p.participant_id
        WHERE p.slot_id = s.id AND tstzrange(c.starts_at, c.blocks_until, '[)') &&
          tstzrange(s.starts_at, s.starts_at + interval '20 minutes', '[)')) AS claimed
    FROM interview.schedule_slot s JOIN interview.interviewer l ON l.id = s.lead_id
    WHERE s.approved_by IS NOT NULL AND s.starts_at >= ${from}::timestamptz AND s.starts_at < ${to}::timestamptz
      AND (${campus} = 'ALL' OR s.campus = ${campus})
    ORDER BY s.starts_at, s.campus, l.display_name`;
  const now = Date.now();
  return rows.map((r) => {
    const local = instantToEasternLocal(r.starts_at);
    const shadowers = r.shadowers ?? [];
    let status: SlotStatus = "open", reason: string | null = null;
    if (r.booked) status = "booked";
    else if (r.claimed) { status = "blocked"; reason = "team member already booked at this time"; }
    else if (!r.lead_active) { status = "blocked"; reason = "lead is not active"; }
    else if (r.starts_at.getTime() <= now + 30 * 60000) { status = "blocked"; reason = "in the past"; }
    else if (r.campus === "BC" && !shadowers.length) { status = "blocked"; reason = "no shadower assigned"; }
    return { id: r.id, campus: r.campus, startsAt: r.starts_at.toISOString(), date: local.date, minute: local.minute,
      lead: r.lead, shadowers, status, reason };
  });
}

type WeekRow = { id: string; email: string; team_role: "lead" | "shadow"; lead_interviewer_id: string | null;
  allowed_campuses: Campus[]; status: string | null; confirmed_at: Date | null;
  effective_windows: WeeklyConfirmation["recurringWindows"] | null; date_overrides: WeeklyConfirmation["overrides"] | null };

function offeredStarts(row: WeekRow, weekStart: string): Set<string> {
  if (row.status !== "confirmed" || !row.confirmed_at) return new Set();
  try {
    return new Set(buildInterviewSlots({ eaId: row.email, weekStart, status: "confirmed",
      confirmedAt: row.confirmed_at.toISOString(), recurringWindows: row.effective_windows ?? [],
      overrides: row.date_overrides ?? [] }).map((s) => easternLocalToInstant(s.date, s.startMinute).toISOString()));
  } catch { return new Set(); }
}

/**
 * Founder action: turn confirmed weekly availability into bookable slots. A slot is
 * created at each time the lead offered; shadowers assigned to that lead join when
 * they offered the same time and aren't already in another overlapping slot.
 * Existing slots and bookings are never changed. Times use America/New_York, so
 * the November daylight-saving change is handled by the timezone conversion.
 */
export async function generateSlotsFromAvailability(campus: Campus, weekStart: string, actor: string,
  db: Sql = interviewStaffDatabase()) {
  validWeek(weekStart);
  if (actor !== "president@campus2care.org") throw new SlotError("founder_access_required");
  return db.begin(async (tx) => {
    const people = await tx<WeekRow[]>`
      SELECT i.id, lower(i.workspace_email) AS email, i.team_role, i.lead_interviewer_id, i.allowed_campuses,
        w.status, w.confirmed_at, w.effective_windows, w.date_overrides
      FROM interview.interviewer i
      LEFT JOIN interview.interviewer_week w ON w.interviewer_id = i.id AND w.week_start = ${weekStart}::date
      WHERE i.staff_access AND i.removed_at IS NULL AND ${campus} = ANY(i.allowed_campuses)
      ORDER BY i.id FOR UPDATE OF i`;
    const leads = people.filter((p) => p.team_role === "lead");
    const offered = new Map(people.map((p) => [p.id, offeredStarts(p, weekStart)]));
    let created = 0, withShadow = 0, skipped = 0;
    const now = Date.now();
    for (const lead of leads) {
      for (const startsAt of offered.get(lead.id) ?? []) {
        if (Date.parse(startsAt) <= now + 30 * 60000) continue;
        const end = new Date(Date.parse(startsAt) + 20 * 60000).toISOString();
        const busy = await tx<{ id: string }[]>`
          SELECT p.participant_id AS id FROM interview.schedule_participant p JOIN interview.schedule_slot s ON s.id = p.slot_id
          WHERE s.starts_at < ${end}::timestamptz AND s.starts_at + interval '20 minutes' > ${startsAt}::timestamptz
          UNION SELECT interviewer_id FROM interview.slot_claim
          WHERE starts_at < ${end}::timestamptz AND blocks_until > ${startsAt}::timestamptz`;
        const taken = new Set(busy.map((b) => b.id));
        if (taken.has(lead.id)) { skipped++; continue; }
        const shadows = people.filter((p) => p.team_role === "shadow" && p.lead_interviewer_id === lead.id &&
          !taken.has(p.id) && offered.get(p.id)?.has(startsAt));
        const inserted = await tx<{ id: string }[]>`
          INSERT INTO interview.schedule_slot (campus, lead_id, starts_at, source_reference, approved_by, approved_at)
          VALUES (${campus}, ${lead.id}, ${startsAt}::timestamptz, ${"availability:" + lead.id + ":" + startsAt}, ${actor}, now())
          ON CONFLICT DO NOTHING RETURNING id`;
        if (!inserted[0]) { skipped++; continue; }
        await tx`INSERT INTO interview.schedule_participant (slot_id, participant_id, role)
          VALUES (${inserted[0].id}, ${lead.id}, 'lead')`;
        for (const shadow of shadows) {
          await tx`INSERT INTO interview.schedule_participant (slot_id, participant_id, role)
            VALUES (${inserted[0].id}, ${shadow.id}, 'shadow')`;
        }
        created++; if (shadows.length) withShadow++;
      }
    }
    await tx`INSERT INTO interview.audit_event (actor_ref, action, object_type, object_id, outcome, metadata)
      VALUES (${actor}, 'generate_slots', 'schedule_slot', ${campus + ":" + weekStart}, 'created',
        ${tx.json({ created, withShadow, skipped })})`;
    return { created, withShadow, skipped };
  });
}

/** Founder action: remove an open slot. Booked or claimed slots are never removed. */
export async function removeOpenSlot(slotId: string, actor: string, db: Sql = interviewStaffDatabase()) {
  if (!/^[0-9a-f-]{36}$/i.test(slotId)) throw new SlotError("invalid_slot");
  if (actor !== "president@campus2care.org") throw new SlotError("founder_access_required");
  return db.begin(async (tx) => {
    const rows = await tx<{ lead_id: string; starts_at: Date }[]>`
      SELECT lead_id, starts_at FROM interview.schedule_slot WHERE id = ${slotId} FOR UPDATE`;
    if (!rows[0]) throw new SlotError("slot_not_found");
    const used = await tx`SELECT 1 FROM interview.reservation WHERE interviewer_id = ${rows[0].lead_id}
        AND starts_at = ${rows[0].starts_at.toISOString()}::timestamptz
        AND status NOT IN ('canceled','expired','failed')
      UNION ALL SELECT 1 FROM interview.slot_claim c JOIN interview.schedule_participant p ON p.participant_id = c.interviewer_id
        WHERE p.slot_id = ${slotId} AND c.starts_at = ${rows[0].starts_at.toISOString()}::timestamptz`;
    if (used.length) throw new SlotError("slot_has_booking");
    await tx`DELETE FROM interview.schedule_participant WHERE slot_id = ${slotId}`;
    await tx`DELETE FROM interview.schedule_slot WHERE id = ${slotId}`;
    await tx`INSERT INTO interview.audit_event (actor_ref, action, object_type, object_id, outcome, metadata)
      VALUES (${actor}, 'remove_slot', 'schedule_slot', ${slotId}, 'removed',
        ${tx.json({ startsAt: rows[0].starts_at.toISOString() })})`;
    return { removed: true };
  });
}
