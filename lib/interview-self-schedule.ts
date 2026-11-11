import type { TransactionSql } from "postgres";
import { buildInterviewSlots, type WeeklyConfirmation } from "./interview-availability";
import { easternLocalToInstant } from "./interview-timezone";
import { interviewWeekChoices } from "./interview-week-choice";

export const RYAN_EMAIL = "ryan.daves@campus2care.org";
export function canPublishOwnSchedule(email: string, role: string, onBehalf: boolean) {
  // Self-publishing stays tied to Ryan's own BC team: the booking transaction accepts exactly this.
  return email === RYAN_EMAIL && role === "chapter_admin" && !onBehalf;
}
export class BookingWarning extends Error {
  constructor(public readonly appointments: string[]) { super("booking_warning_required"); }
}
export function selfScheduleStarts(record: WeeklyConfirmation, now = new Date()) {
  if (record.eaId !== RYAN_EMAIL || record.weekStart < interviewWeekChoices(now).current) {
    throw Error("invalid_self_schedule_scope");
  }
  return new Set(record.status === "confirmed" ? buildInterviewSlots(record)
    .map(slot => easternLocalToInstant(slot.date, slot.startMinute).toISOString()) : []);
}

/** Called inside the availability transaction. Never changes reservations or another person's hours. */
export async function publishOwnSchedule(tx: TransactionSql, id: string, record: WeeklyConfirmation) {
  const offered = selfScheduleStarts(record);
  const people = await tx<{id:string; workspace_email:string; team_role:string; lead_interviewer_id:string|null;
    status:string|null; confirmed_at:Date|null; effective_windows:WeeklyConfirmation["recurringWindows"]; date_overrides:WeeklyConfirmation["overrides"]}[]>`
    SELECT i.id,i.workspace_email,i.team_role,i.lead_interviewer_id,w.status,w.confirmed_at,w.effective_windows,w.date_overrides
    FROM interview.interviewer i LEFT JOIN interview.interviewer_week w
      ON w.interviewer_id=i.id AND w.week_start=${record.weekStart}::date
    WHERE i.staff_access AND i.removed_at IS NULL AND 'BC'=ANY(i.allowed_campuses)
    ORDER BY i.id FOR UPDATE OF i`;
  const self = people.find(person => person.id === id && person.workspace_email === RYAN_EMAIL);
  if (!self) throw Error("invalid_self_schedule_scope");
  const rows = await tx<{id:string;lead_id:string;starts_at:Date; protected:boolean}[]>`
    SELECT s.id,s.lead_id,s.starts_at,EXISTS (
      SELECT 1 FROM interview.reservation r WHERE r.interviewer_id=s.lead_id AND r.starts_at=s.starts_at
        AND r.status NOT IN ('canceled','expired','failed')
      UNION ALL SELECT 1 FROM interview.slot_claim c JOIN interview.schedule_participant p ON p.participant_id=c.interviewer_id
        WHERE p.slot_id=s.id AND c.starts_at<s.starts_at+interval '20 minutes' AND c.blocks_until>s.starts_at
    ) AS protected
    FROM interview.schedule_slot s WHERE s.campus='BC'
      AND (s.lead_id=${id} OR s.lead_id=${self.lead_interviewer_id})
      AND (s.starts_at AT TIME ZONE 'America/New_York')::date BETWEEN ${record.weekStart}::date AND ${record.weekStart}::date+6
    ORDER BY s.starts_at FOR UPDATE OF s`;
  let created=0, removed=0, awaitingTeam=0;
  for (const slot of rows) {
    if (slot.protected || slot.starts_at.getTime() <= Date.now()) continue;
    if (slot.lead_id === id && !offered.has(slot.starts_at.toISOString())) {
      await tx`DELETE FROM interview.schedule_participant WHERE slot_id=${slot.id}`;
      await tx`DELETE FROM interview.schedule_slot WHERE id=${slot.id}`;
      removed++;
    } else if (self.team_role === "shadow" && !offered.has(slot.starts_at.toISOString())) {
      await tx`DELETE FROM interview.schedule_participant WHERE slot_id=${slot.id} AND participant_id=${id} AND role='shadow'`;
      await tx`UPDATE interview.schedule_slot SET revision=revision+1 WHERE id=${slot.id}`;
    }
  }
  const available = new Map(people.map(person => [person.id, person.status === "confirmed" && person.confirmed_at
    ? new Set(buildInterviewSlots({eaId:person.workspace_email,weekStart:record.weekStart,status:"confirmed",
      confirmedAt:person.confirmed_at.toISOString(),recurringWindows:person.effective_windows ?? [],overrides:person.date_overrides ?? []})
      .map(slot=>easternLocalToInstant(slot.date,slot.startMinute).toISOString())) : new Set<string>()]));
  for (const start of offered) {
    if (Date.parse(start) <= Date.now()+30*60000) continue;
    let slot = rows.find(row=>row.starts_at.toISOString()===start && row.lead_id===(self.team_role==="lead"?id:self.lead_interviewer_id));
    if (slot?.protected) continue;
    const end = new Date(Date.parse(start)+20*60000).toISOString();
    const busy = await tx<{id:string}[]>`SELECT p.participant_id AS id FROM interview.schedule_participant p
      JOIN interview.schedule_slot s ON s.id=p.slot_id
      WHERE s.id IS DISTINCT FROM ${slot?.id ?? null}::uuid AND s.starts_at<${end}::timestamptz
        AND s.starts_at+interval '20 minutes'>${start}::timestamptz
      UNION SELECT interviewer_id FROM interview.slot_claim WHERE starts_at<${end}::timestamptz AND blocks_until>${start}::timestamptz`;
    const taken = new Set(busy.map(person=>person.id));
    if (taken.has(id)) { awaitingTeam++; continue; }
    if (self.team_role === "lead") {
      if (!slot) {
        const inserted = await tx<{id:string}[]>`INSERT INTO interview.schedule_slot
          (campus,lead_id,starts_at,source_reference,approved_by,approved_at)
          VALUES ('BC',${id},${start}::timestamptz,${"self:"+id+":"+start},${RYAN_EMAIL},now())
          ON CONFLICT DO NOTHING RETURNING id`;
        if (!inserted[0]) continue;
        slot={id:inserted[0].id,lead_id:id,starts_at:new Date(start),protected:false}; created++;
        await tx`INSERT INTO interview.schedule_participant(slot_id,participant_id,role) VALUES (${slot.id},${id},'lead')`;
      }
      // Refresh only unbooked teams using each assigned shadower's own confirmed hours.
      await tx`DELETE FROM interview.schedule_participant WHERE slot_id=${slot.id} AND role='shadow'`;
      for (const shadow of people.filter(person=>person.team_role==="shadow" && person.lead_interviewer_id===id && !taken.has(person.id) && available.get(person.id)?.has(start))) {
        await tx`INSERT INTO interview.schedule_participant(slot_id,participant_id,role) VALUES (${slot.id},${shadow.id},'shadow') ON CONFLICT DO NOTHING`;
      }
      await tx`UPDATE interview.schedule_slot SET approved_by=${RYAN_EMAIL},approved_at=now(),revision=revision+1 WHERE id=${slot.id} AND lead_id=${id} AND campus='BC'`;
    } else if (self.team_role === "shadow") {
      // A lead's confirmed matching hours are required; Ryan cannot change their availability.
      const lead = people.find(person=>person.id===self.lead_interviewer_id && person.team_role==="lead");
      if (!slot && lead && available.get(lead.id)?.has(start) && !taken.has(lead.id)) {
        const inserted = await tx<{id:string}[]>`INSERT INTO interview.schedule_slot
          (campus,lead_id,starts_at,source_reference,approved_by,approved_at)
          VALUES ('BC',${lead.id},${start}::timestamptz,${"self:"+id+":"+start},${RYAN_EMAIL},now())
          ON CONFLICT DO NOTHING RETURNING id`;
        if (inserted[0]) {
          slot={id:inserted[0].id,lead_id:lead.id,starts_at:new Date(start),protected:false}; created++;
          await tx`INSERT INTO interview.schedule_participant(slot_id,participant_id,role) VALUES (${slot.id},${lead.id},'lead')`;
        }
      }
      if (!slot) { awaitingTeam++; continue; }
      await tx`INSERT INTO interview.schedule_participant(slot_id,participant_id,role) VALUES (${slot.id},${id},'shadow') ON CONFLICT DO NOTHING`;
      await tx`UPDATE interview.schedule_slot SET revision=revision+1 WHERE id=${slot.id}`;
    }
  }
  await tx`INSERT INTO interview.audit_event(actor_ref,action,object_type,object_id,outcome,metadata)
    VALUES (${RYAN_EMAIL},'publish_own_schedule','interviewer_week',${id+":"+record.weekStart},'published',${tx.json({created,removed})})`;
  return {created,removed,awaitingTeam};
}
