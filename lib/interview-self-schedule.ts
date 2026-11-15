import type { TransactionSql } from "postgres";
import { buildInterviewSlots, type WeeklyConfirmation, type WeeklyWindows } from "./interview-availability";
import { resolveStandingWindows } from "./interview-standing-hours";
import { easternLocalToInstant, isNextDayOrLaterInEasternTime } from "./interview-timezone";
import { interviewWeekChoices } from "./interview-week-choice";

export const RYAN_EMAIL = "ryan.daves@campus2care.org";
const PRESIDENT = "president@campus2care.org";

export type SchedulePublication = {
  created: number;
  removed: number;
  awaitingTeam: number;
  attached: number;
  detached: number;
};

/**
 * Unlocks editing a founder-managed week, and only for Ryan acting on himself.
 * Confirming hours publishes slots for every active lead; this flag does not
 * decide who may publish.
 */
export function canPublishOwnSchedule(email: string, role: string, onBehalf: boolean) {
  return email === RYAN_EMAIL && role === "chapter_admin" && !onBehalf;
}

export class BookingWarning extends Error {
  constructor(public readonly appointments: string[]) { super("booking_warning_required"); }
}

type Campus = "BU" | "BC";
type Person = {
  id: string;
  workspace_email: string;
  team_role: "lead" | "shadow";
  lead_interviewer_id: string | null;
  active: boolean;
  weekly_capacity_limit: number;
  allowed_campuses: string[] | null;
  status: WeeklyConfirmation["status"] | null;
  confirmed_at: Date | null;
  effective_windows: WeeklyConfirmation["recurringWindows"] | null;
  date_overrides: WeeklyConfirmation["overrides"] | null;
  template_windows?: WeeklyWindows[] | null;
};
type SlotRow = {
  id: string;
  lead_id: string;
  campus: Campus;
  starts_at: Date;
  approved_by: string | null;
  protected: boolean;
};

function campusesOf(person: { allowed_campuses: string[] | null }): Campus[] {
  return (person.allowed_campuses ?? []).filter((campus): campus is Campus => campus === "BU" || campus === "BC");
}

function startsFrom(record: WeeklyConfirmation): Set<string> {
  if (record.status !== "confirmed") return new Set();
  return new Set(buildInterviewSlots(record)
    .map(slot => easternLocalToInstant(slot.date, slot.startMinute).toISOString()));
}

function startsFromRow(person: Person, weekStart: string): Set<string> {
  const resolved = resolveStandingWindows(weekStart, person.status ? {
    status: person.status, recurringWindows: person.effective_windows, overrides: person.date_overrides,
    confirmedAt: person.confirmed_at?.toISOString() ?? null,
  } : null, person.template_windows ? { recurringWindows: person.template_windows } : null);
  if (resolved.source !== "week" && resolved.source !== "template") return new Set();
  try {
    return startsFrom({
      eaId: person.workspace_email, weekStart, status: "confirmed",
      confirmedAt: person.confirmed_at?.toISOString() ?? "2026-01-01T00:00:00.000Z",
      recurringWindows: resolved.windows, overrides: [],
    });
  } catch {
    return new Set();
  }
}

/**
 * `active` means this person may host an interview as the lead. Roster writes
 * set it true for leads and false for shadowers, who keep staff_access instead.
 */
export function canHostAsLead(person: Pick<Person, "team_role" | "active" | "weekly_capacity_limit" | "allowed_campuses">, campus: Campus): boolean {
  return person.team_role === "lead" && person.active === true && Number(person.weekly_capacity_limit) > 0
    && campusesOf(person).includes(campus);
}

/** Assigned, signed-in shadower. `active` is intentionally ignored. */
export function canAttachAsShadow(person: Pick<Person, "team_role" | "lead_interviewer_id" | "allowed_campuses">, leadId: string, campus: Campus): boolean {
  return person.team_role === "shadow" && person.lead_interviewer_id === leadId
    && campusesOf(person).includes(campus);
}

function emptyPublication(): SchedulePublication {
  return { created: 0, removed: 0, awaitingTeam: 0, attached: 0, detached: 0 };
}

/** Applicant booking already rejects the current Eastern day and the next 30 minutes. */
function isPublishableStart(start: Date, now: Date): boolean {
  return start.getTime() > now.getTime() + 30 * 60000 && isNextDayOrLaterInEasternTime(start, now);
}

async function overlappingPeople(tx: TransactionSql, slotId: string | null, start: string): Promise<Set<string>> {
  const end = new Date(Date.parse(start) + 20 * 60000).toISOString();
  const busy = await tx<{ id: string }[]>`
    SELECT p.participant_id AS id FROM interview.schedule_participant p
    JOIN interview.schedule_slot s ON s.id = p.slot_id
    WHERE s.id IS DISTINCT FROM ${slotId}::uuid
      AND s.starts_at < ${end}::timestamptz
      AND s.starts_at + interval '20 minutes' > ${start}::timestamptz
    UNION
    SELECT interviewer_id AS id FROM interview.slot_claim
    WHERE starts_at < ${end}::timestamptz AND blocks_until > ${start}::timestamptz`;
  return new Set(busy.map(person => person.id));
}

/**
 * Inside the availability transaction. Writes schedule_slot rows for an active
 * lead and attaches shadowers whose confirmed hours cover an unbooked slot.
 * Booked or claimed slots are never updated. A shadower is not required.
 */
export async function publishOwnSchedule(
  tx: TransactionSql, id: string, record: WeeklyConfirmation, now = new Date(),
): Promise<SchedulePublication | undefined> {
  if (record.eaId !== record.eaId.trim().toLowerCase() || record.weekStart < interviewWeekChoices(now).current) {
    return undefined;
  }
  const subjectRows = await tx<Person[]>`
    SELECT i.id, lower(i.workspace_email) AS workspace_email, i.team_role, i.lead_interviewer_id,
      i.active, i.weekly_capacity_limit, i.allowed_campuses,
      w.status, w.confirmed_at, w.effective_windows, w.date_overrides, t.recurring_windows AS template_windows
    FROM interview.interviewer i
    LEFT JOIN interview.interviewer_week w
      ON w.interviewer_id = i.id AND w.week_start = ${record.weekStart}::date
    LEFT JOIN interview.interviewer_template t ON t.interviewer_id = i.id
    WHERE i.id = ${id} AND i.staff_access AND i.removed_at IS NULL
    FOR UPDATE OF i`;
  const subject = subjectRows[0];
  if (!subject || subject.workspace_email !== record.eaId) return undefined;
  if (subject.team_role !== "lead" && subject.team_role !== "shadow") return undefined;
  const leadId = subject.team_role === "lead" ? subject.id : subject.lead_interviewer_id;
  if (!leadId) return undefined;
  const hostCampuses = campusesOf(subject).filter(campus =>
    subject.team_role === "shadow" || canHostAsLead(subject, campus));
  if (!hostCampuses.length) return undefined;

  const people = await tx<Person[]>`
    SELECT i.id, lower(i.workspace_email) AS workspace_email, i.team_role, i.lead_interviewer_id,
      i.active, i.weekly_capacity_limit, i.allowed_campuses,
      w.status, w.confirmed_at, w.effective_windows, w.date_overrides, t.recurring_windows AS template_windows
    FROM interview.interviewer i
    LEFT JOIN interview.interviewer_week w
      ON w.interviewer_id = i.id AND w.week_start = ${record.weekStart}::date
    LEFT JOIN interview.interviewer_template t ON t.interviewer_id = i.id
    WHERE i.staff_access AND i.removed_at IS NULL
      AND (i.id = ${leadId} OR i.lead_interviewer_id = ${leadId})
    ORDER BY i.id
    FOR UPDATE OF i`;
  const lead = people.find(person => person.id === leadId && person.team_role === "lead");
  if (!lead) return undefined;
  const slots = await tx<SlotRow[]>`
    SELECT s.id, s.lead_id, s.campus, s.starts_at, s.approved_by, EXISTS (
      SELECT 1 FROM interview.reservation r
      WHERE r.interviewer_id = s.lead_id AND r.starts_at = s.starts_at
        AND r.status NOT IN ('canceled','expired','failed')
      UNION ALL
      SELECT 1 FROM interview.slot_claim c
      JOIN interview.schedule_participant p ON p.participant_id = c.interviewer_id
      WHERE p.slot_id = s.id
        AND c.starts_at < s.starts_at + interval '20 minutes'
        AND c.blocks_until > s.starts_at
    ) AS protected
    FROM interview.schedule_slot s
    WHERE s.lead_id = ${leadId}
      AND (s.starts_at AT TIME ZONE 'America/New_York')::date
        BETWEEN ${record.weekStart}::date AND ${record.weekStart}::date + 6
    ORDER BY s.starts_at
    FOR UPDATE OF s`;

  const result = emptyPublication();
  if (subject.team_role === "shadow") {
    const offered = startsFrom(record);
    for (const slot of slots) {
      if (slot.protected || slot.starts_at.getTime() <= now.getTime()) continue;
      if (!canAttachAsShadow(subject, leadId, slot.campus)) continue;
      const start = slot.starts_at.toISOString();
      const taken = offered.has(start) ? await overlappingPeople(tx, slot.id, start) : new Set<string>();
      if (offered.has(start) && !taken.has(subject.id)) {
        const inserted = await tx<{ participant_id: string }[]>`
          INSERT INTO interview.schedule_participant (slot_id, participant_id, role)
          VALUES (${slot.id}, ${subject.id}, 'shadow')
          ON CONFLICT DO NOTHING
          RETURNING participant_id`;
        if (inserted.length) {
          result.attached++;
          await tx`UPDATE interview.schedule_slot SET revision = revision + 1 WHERE id = ${slot.id}`;
        }
      } else {
        const removed = await tx<{ participant_id: string }[]>`
          DELETE FROM interview.schedule_participant
          WHERE slot_id = ${slot.id} AND participant_id = ${subject.id} AND role = 'shadow'
          RETURNING participant_id`;
        if (removed.length) {
          result.detached++;
          await tx`UPDATE interview.schedule_slot SET revision = revision + 1 WHERE id = ${slot.id}`;
        }
      }
    }
    await tx`INSERT INTO interview.audit_event (actor_ref, action, object_type, object_id, outcome, metadata)
      VALUES (${subject.workspace_email}, 'auto_attach_shadow', 'interviewer_week',
        ${subject.id + ":" + record.weekStart}, 'attached',
        ${tx.json({ attached: result.attached, detached: result.detached, leadId })})`;
    return result;
  }

  const offered = startsFrom(record);
  const removedSlotIds = new Set<string>();
  for (const slot of slots) {
    if (slot.protected || slot.starts_at.getTime() <= now.getTime()) continue;
    if (!hostCampuses.includes(slot.campus)) continue;
    if (offered.has(slot.starts_at.toISOString())) continue;
    await tx`DELETE FROM interview.schedule_participant WHERE slot_id = ${slot.id}`;
    await tx`DELETE FROM interview.schedule_slot WHERE id = ${slot.id}`;
    removedSlotIds.add(slot.id);
    result.removed++;
  }
  const preferredCampus = slots.find(slot => hostCampuses.includes(slot.campus))?.campus ?? hostCampuses[0];
  const campusForStart = (start: string, existing: SlotRow | undefined): Campus => {
    if (existing && hostCampuses.includes(existing.campus)) return existing.campus;
    // One campus keeps the existing publication campus. A lead who also hosts
    // another campus gets a new time on the shadow team's campus only when
    // exactly one of those teams overlaps; other times stay on the preferred campus.
    if (hostCampuses.length <= 1) return preferredCampus;
    const overlapped = hostCampuses.filter((campus) => people.some((person) =>
      canAttachAsShadow(person, lead.id, campus) && startsFromRow(person, record.weekStart).has(start)));
    return overlapped.length === 1 ? overlapped[0] : preferredCampus;
  };
  for (const start of offered) {
    const startsAt = new Date(start);
    if (!isPublishableStart(startsAt, now)) continue;
    let slot = slots.find(row => row.starts_at.toISOString() === start && !removedSlotIds.has(row.id));
    if (slot?.protected) continue;
    if (slot && !hostCampuses.includes(slot.campus)) continue;
    const taken = await overlappingPeople(tx, slot?.id ?? null, start);
    if (taken.has(lead.id)) { result.awaitingTeam++; continue; }
    const campus = campusForStart(start, slot);
    if (!slot) {
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO interview.schedule_slot
          (campus, lead_id, starts_at, source_reference, approved_by, approved_at)
        VALUES (${campus}, ${lead.id}, ${start}::timestamptz,
          ${"availability:" + lead.id + ":" + start}, ${lead.workspace_email}, now())
        ON CONFLICT DO NOTHING
        RETURNING id`;
      if (!inserted[0]) { result.awaitingTeam++; continue; }
      slot = {
        id: inserted[0].id, lead_id: lead.id, campus, starts_at: startsAt,
        approved_by: lead.workspace_email, protected: false,
      };
      result.created++;
      await tx`INSERT INTO interview.schedule_participant (slot_id, participant_id, role)
        VALUES (${slot.id}, ${lead.id}, 'lead')`;
    } else if ((slot.approved_by ?? "").toLowerCase() !== PRESIDENT) {
      await tx`UPDATE interview.schedule_slot
        SET approved_by = ${lead.workspace_email}, approved_at = now(), revision = revision + 1
        WHERE id = ${slot.id} AND lead_id = ${lead.id}`;
    }
    await tx`INSERT INTO interview.schedule_participant (slot_id, participant_id, role)
      VALUES (${slot.id}, ${lead.id}, 'lead') ON CONFLICT DO NOTHING`;
    const current = await tx<{ participant_id: string }[]>`
      SELECT participant_id FROM interview.schedule_participant
      WHERE slot_id = ${slot.id} AND role = 'shadow'`;
    const desired = people.filter(person => canAttachAsShadow(person, lead.id, campus) && !taken.has(person.id)
      && (person.id === subject.id ? offered : startsFromRow(person, record.weekStart)).has(start));
    const desiredIds = new Set(desired.map(person => person.id));
    let changed = false;
    for (const row of current) {
      if (desiredIds.has(row.participant_id)) continue;
      await tx`DELETE FROM interview.schedule_participant
        WHERE slot_id = ${slot.id} AND participant_id = ${row.participant_id} AND role = 'shadow'`;
      result.detached++;
      changed = true;
    }
    for (const person of desired) {
      if (current.some(row => row.participant_id === person.id)) continue;
      const inserted = await tx<{ participant_id: string }[]>`
        INSERT INTO interview.schedule_participant (slot_id, participant_id, role)
        VALUES (${slot.id}, ${person.id}, 'shadow')
        ON CONFLICT DO NOTHING
        RETURNING participant_id`;
      if (inserted.length) { result.attached++; changed = true; }
    }
    if (changed && (slot.approved_by ?? "").toLowerCase() === PRESIDENT) {
      await tx`UPDATE interview.schedule_slot SET revision = revision + 1 WHERE id = ${slot.id}`;
    }
  }
  await tx`INSERT INTO interview.audit_event (actor_ref, action, object_type, object_id, outcome, metadata)
    VALUES (${lead.workspace_email}, 'auto_publish_schedule', 'interviewer_week',
      ${lead.id + ":" + record.weekStart}, 'published',
      ${tx.json({ created: result.created, removed: result.removed, awaitingTeam: result.awaitingTeam,
        attached: result.attached, detached: result.detached, campuses: hostCampuses })})`;
  return result;
}
