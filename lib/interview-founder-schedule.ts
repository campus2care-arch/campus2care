import { authorizedRole } from "./interview-auth";
import { interviewDatabase } from "./interview-db";
import { instantToEasternLocal, easternLocalToInstant } from "./interview-timezone";
export type FounderShiftEdit={slotId:string;revision:string;startsAt:string;leadEmail:string;shadowEmails:string[]};
export function validateFounderShiftEdit(raw:unknown):FounderShiftEdit {
 if(!raw||typeof raw!=="object")throw Error("invalid_shift");
 const v=raw as FounderShiftEdit;
 if(!/^[a-f0-9-]{36}$/i.test(v.slotId??"")||!/^\d+$/.test(v.revision??"")||!Array.isArray(v.shadowEmails)||v.shadowEmails.length>5||typeof v.leadEmail!=="string"||v.shadowEmails.some(e=>typeof e!=="string"))throw Error("invalid_shift");
 const emails=[v.leadEmail,...v.shadowEmails].map(e=>e.trim().toLowerCase());
 if(new Set(emails).size!==emails.length||emails.some(e=>!authorizedRole(e)))throw Error("participant_not_authorized");
 const time=new Date(v.startsAt),local=instantToEasternLocal(time);
 if(time.toISOString()!==v.startsAt||local.date<'2026-11-02'||local.date>'2026-11-08'||local.minute%5!==0||time.getTime()<=Date.now()||easternLocalToInstant(local.date,local.minute).getTime()!==time.getTime())throw Error("outside_founder_week");
 return {...v,leadEmail:emails[0],shadowEmails:emails.slice(1)};
}
/** Founder-only edits never mutate a booked slot, reservation, or external event. */
export async function correctFounderShift(raw:unknown,actor:string){
 if(actor!=="president@campus2care.org"||process.env.VERCEL_ENV!=="preview")throw Error("founder_access_required");
 const input=validateFounderShiftEdit(raw);
 return interviewDatabase().begin(async tx=>{
  const rows=await tx<{id:string;lead_id:string;starts_at:Date;campus:string;revision:string;approved_by:string|null}[]>`SELECT id,lead_id,starts_at,campus,revision::text AS revision,approved_by FROM interview.schedule_slot WHERE id=${input.slotId} FOR UPDATE`;
  const slot=rows[0];if(!slot||slot.approved_by!==actor)throw Error("founder_shift_not_found");
  if(slot.revision!==input.revision)throw Error("shift_modified_elsewhere");
  const old=await tx<{participant_id:string}[]>`SELECT participant_id FROM interview.schedule_participant WHERE slot_id=${slot.id}`;
  const emails=[input.leadEmail,...input.shadowEmails];
  const staff=await tx<{id:string;workspace_email:string;active:boolean;allowed_campuses:string[]}[]>`SELECT id,workspace_email,active,allowed_campuses FROM interview.interviewer
    WHERE workspace_email=ANY(${emails}::text[]) OR id=ANY(${old.map(p=>p.participant_id)}::uuid[]) ORDER BY id FOR UPDATE`;
  const lead=staff.find(p=>p.workspace_email===input.leadEmail);
  if(!lead?.active||!lead.allowed_campuses.includes(slot.campus)||emails.some(email=>!staff.some(p=>p.workspace_email===email)))throw Error("participant_roster_unavailable");
  await tx`SELECT interviewer_id FROM interview.interviewer_week WHERE week_start='2026-11-02' AND interviewer_id=ANY(${staff.map(p=>p.id)}::uuid[]) ORDER BY interviewer_id FOR UPDATE`;
  const booked=await tx`SELECT id FROM interview.reservation WHERE interviewer_id=${slot.lead_id} AND starts_at=${slot.starts_at.toISOString()} AND status NOT IN ('canceled','expired','failed')
    UNION ALL SELECT reservation_id FROM interview.reschedule_request WHERE interviewer_id=${slot.lead_id} AND starts_at=${slot.starts_at.toISOString()} AND state IN ('pending','cancel_pending','reconcile_required')`;
  if(booked.length)throw Error("booked_shift_preserved");
  const ids=emails.map(email=>staff.find(p=>p.workspace_email===email)!.id);
  const end=new Date(Date.parse(input.startsAt)+20*60000).toISOString();
  const conflict=await tx`SELECT p.slot_id FROM interview.schedule_participant p JOIN interview.schedule_slot s ON s.id=p.slot_id
    WHERE p.participant_id=ANY(${ids}::uuid[]) AND s.id<>${slot.id} AND s.starts_at<${end}::timestamptz AND s.starts_at+interval '20 minutes'>${input.startsAt}::timestamptz
    UNION ALL SELECT NULL::uuid FROM interview.slot_claim WHERE interviewer_id=ANY(${ids}::uuid[]) AND starts_at<${end}::timestamptz AND blocks_until>${input.startsAt}::timestamptz`;
  if(conflict.length)throw Error("participant_schedule_conflict");
  await tx`UPDATE interview.schedule_slot SET lead_id=${lead.id},starts_at=${input.startsAt},revision=revision+1,approved_at=now() WHERE id=${slot.id}`;
  await tx`DELETE FROM interview.schedule_participant WHERE slot_id=${slot.id}`;
  for(const [i,id]of ids.entries())await tx`INSERT INTO interview.schedule_participant(slot_id,participant_id,role) VALUES(${slot.id},${id},${i===0?'lead':'shadow'})`;
  // Rebuild only the explicitly founder-managed week's date overrides. No template changes.
  for(const person of staff){
   const times=await tx<{date:string;minute:number}[]>`SELECT to_char(s.starts_at AT TIME ZONE 'America/New_York','YYYY-MM-DD') AS date,
     (extract(hour FROM s.starts_at AT TIME ZONE 'America/New_York')*60+extract(minute FROM s.starts_at AT TIME ZONE 'America/New_York'))::int AS minute
     FROM interview.schedule_slot s JOIN interview.schedule_participant p ON p.slot_id=s.id WHERE p.participant_id=${person.id} AND s.approved_by=${actor}
     AND (s.starts_at AT TIME ZONE 'America/New_York')::date BETWEEN date '2026-11-02' AND date '2026-11-08' ORDER BY s.starts_at`;
   const days=new Map<string,{startMinute:number;endMinute:number}[]>();for(const time of times){const windows=days.get(time.date)??[];windows.push({startMinute:time.minute,endMinute:time.minute+20});days.set(time.date,windows);}
   const overrides=[...days].map(([date,windows])=>({date,kind:'replace',windows}));
   await tx`INSERT INTO interview.interviewer_week(interviewer_id,week_start,status,confirmed_at,effective_windows,date_overrides,approval_source)
    VALUES(${person.id},'2026-11-02','confirmed',now(),'[]'::jsonb,${tx.json(overrides)},'founder')
    ON CONFLICT(interviewer_id,week_start) DO UPDATE SET date_overrides=EXCLUDED.date_overrides,revision=interviewer_week.revision+1,updated_at=now()
    WHERE interviewer_week.approval_source='founder'`;
  }
  await tx`INSERT INTO interview.audit_event(actor_ref,action,object_type,object_id,outcome,metadata) VALUES(${actor},'correct_founder_shift','schedule_slot',${slot.id},'updated',${tx.json({previousStart:slot.starts_at.toISOString(),startsAt:input.startsAt,leadEmail:input.leadEmail,shadowEmails:input.shadowEmails})})`;
  return {revision:String(BigInt(slot.revision)+BigInt(1))};
 });
}
