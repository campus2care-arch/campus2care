import { interviewTeamDescription, readInterviewTeams, teamForSlot } from "./interview-teams";
import { interviewBufferForWeek } from "./interview-week-policy";
import {syntheticCalendarAttendees} from './interview-calendar-attendees';
import {interviewDatabase} from './interview-db';
import {googleProviderAccessToken} from './interview-google-provider-auth';
import {createSyntheticInterviewCalendarEvent,cancelSyntheticInterviewCalendarEvent,InterviewCalendarProviderError} from './interview-calendar-provider';
import {buildInterviewSlots,type WeeklyConfirmation} from './interview-availability';
import {instantToEasternLocal} from './interview-timezone';
import type {InterviewOutboxJob,OutboxResult} from './interview-outbox';

/** Replacement provisioning and cleanup are idempotent; the old slot stays locked until cleanup succeeds. */
export async function handleRescheduleJob(job:InterviewOutboxJob):Promise<OutboxResult>{
  const db=interviewDatabase();
  const rows=await db<{id:string;reservation_id:string;interviewer_id:string;starts_at:Date;ends_at:Date;state:string;original_calendar_key:string;notion_page_id:string;campus:string}[]>`SELECT x.*,r.notion_page_id,r.campus FROM interview.reschedule_request x JOIN interview.reservation r ON r.id=x.reservation_id WHERE x.id=${job.object_id}`;
  const hold=rows[0];if(!hold?.notion_page_id.startsWith('synthetic-'))return {state:'failed',errorCode:'synthetic_reschedule_required'};
  if(process.env.INTERVIEW_SYNTHETIC_CALENDAR_ENABLED!=='true')return {state:'retry',errorCode:'synthetic_calendar_disabled'};
  const key='interview-calendar:reschedule:'+hold.id;
  try{
    const token=await googleProviderAccessToken('calendar');
    if(job.action==='reschedule_cleanup_old'){
      if(hold.state!=='completed')return {state:'retry',errorCode:'replacement_not_confirmed'};
      await cancelSyntheticInterviewCalendarEvent(token,hold.original_calendar_key);
      await db`DELETE FROM interview.slot_claim WHERE claim_key=${'retired:'+hold.id} OR starts_with(claim_key,${'retired:'+hold.id+':participant:'})`;
      return {state:'done',externalId:null};
    }
    if(job.action==='reschedule_cleanup_new'){
      if(hold.state==='completed')return {state:'failed',errorCode:'active_replacement_cleanup_forbidden'};
      const creating=await db`SELECT id FROM interview.integration_outbox WHERE object_id=${hold.id} AND action='reschedule_create' AND state='processing'`;
      if(creating.length)return {state:'retry',errorCode:'reschedule_creation_in_progress'};
      await cancelSyntheticInterviewCalendarEvent(token,key);
      await db.begin(async tx=>{
        await tx`DELETE FROM interview.slot_claim WHERE claim_key=${'reschedule:'+hold.id} OR starts_with(claim_key,${'reschedule:'+hold.id+':participant:'})`;
        await tx`UPDATE interview.reschedule_request SET state='canceled',updated_at=now() WHERE id=${hold.id} AND state<>'completed'`;
      });
      return {state:'done',externalId:null};
    }
    if(job.action!=='reschedule_create')return {state:'failed',errorCode:'unsupported_reschedule_operation'};
    if(hold.state==='completed'||hold.state==='canceled')return {state:'done',externalId:null};
    if(hold.state==='cancel_pending'){
      await db`INSERT INTO interview.integration_outbox(operation_key,provider,action,object_id) VALUES(${'reschedule-cleanup-new:'+hold.id},'google_calendar','reschedule_cleanup_new',${hold.id}) ON CONFLICT DO NOTHING`;
      return {state:'done',externalId:null};
    }
    const event=await createSyntheticInterviewCalendarEvent({accessToken:token,operationKey:key,startsAt:hold.starts_at.toISOString(),endsAt:hold.ends_at.toISOString(),teamDescription:await interviewTeamDescription(db,hold.interviewer_id,hold.starts_at.toISOString(),hold.campus),attendees:await syntheticCalendarAttendees(hold.interviewer_id)});
    if(event.status==='cancelled')return {state:'reconcile_required',errorCode:'replacement_event_canceled'};
    if(!event.meetUrl)return {state:'retry',errorCode:'meet_provisioning_pending'};
    await db.begin(async tx=>{
      await tx`SELECT i.id FROM interview.invitation i JOIN interview.reservation r ON r.invitation_id=i.id WHERE r.id=${hold.reservation_id} FOR UPDATE OF i`;
      const ea=await tx<{active:boolean;weekly_capacity_limit:number;workspace_email:string;allowed_campuses:string[]}[]>`SELECT active,weekly_capacity_limit,workspace_email,allowed_campuses FROM interview.interviewer WHERE id=${hold.interviewer_id} FOR UPDATE`;
      const current=await tx<{status:string;calendar_operation_key:string|null;interviewer_id:string;starts_at:Date}[]>`SELECT status,calendar_operation_key,interviewer_id,starts_at FROM interview.reservation WHERE id=${hold.reservation_id} FOR UPDATE`;
      const requests=await tx<{state:string}[]>`SELECT state FROM interview.reschedule_request WHERE id=${hold.id} FOR UPDATE`;
      if(requests[0]?.state==='completed')return;

      const local=instantToEasternLocal(hold.starts_at);
      const weeks=await tx<{status:string;confirmed_at:Date|null;effective_windows:WeeklyConfirmation['recurringWindows'];date_overrides:WeeklyConfirmation['overrides'];week_start:string}[]>`SELECT status,confirmed_at,effective_windows,date_overrides,to_char(week_start,'YYYY-MM-DD') AS week_start FROM interview.interviewer_week WHERE interviewer_id=${hold.interviewer_id} AND week_start=date_trunc('week',${hold.starts_at.toISOString()}::timestamptz AT TIME ZONE 'America/New_York')::date FOR UPDATE`;
      const week=weeks[0],roster=ea[0];
      const validSlot=week?.status==='confirmed'&&week.confirmed_at&&buildInterviewSlots({eaId:roster?.workspace_email??'',weekStart:week.week_start,status:'confirmed',confirmedAt:week.confirmed_at.toISOString(),recurringWindows:week.effective_windows,overrides:week.date_overrides}).some(s=>s.date===local.date&&s.startMinute===local.minute);
      const counts=await tx<{booked:number}[]>`SELECT count(*)::int AS booked FROM interview.slot_claim WHERE interviewer_id=${hold.interviewer_id} AND claim_key NOT IN (${'reservation:'+hold.reservation_id},${'reschedule:'+hold.id}) AND (starts_at AT TIME ZONE 'America/New_York')::date BETWEEN ${week?.week_start??local.date}::date AND (${week?.week_start??local.date}::date+6)`;
      const original=current[0];
      const team=week?.week_start==="2026-11-02"?teamForSlot(await readInterviewTeams(tx),hold.interviewer_id,hold.starts_at.toISOString(),hold.campus):undefined;
      const teamAvailable=week?.week_start!=="2026-11-02"||!!team&&team.participants.every(p=>p.available);
      const canMove=teamAvailable&&requests[0]?.state==='pending'&&original?.status==='confirmed'&&(original.calendar_operation_key??'interview-calendar:create:'+hold.reservation_id)===hold.original_calendar_key&&roster?.active&&roster.allowed_campuses.includes(hold.campus)&&counts[0].booked<roster.weekly_capacity_limit&&validSlot&&hold.starts_at.getTime()>Date.now();
      if(!canMove){
        await tx`UPDATE interview.reschedule_request SET state='cancel_pending',updated_at=now() WHERE id=${hold.id}`;
        await tx`INSERT INTO interview.integration_outbox(operation_key,provider,action,object_id) VALUES(${'reschedule-cleanup-new:'+hold.id},'google_calendar','reschedule_cleanup_new',${hold.id}) ON CONFLICT DO NOTHING`;
        return;
      }
      await tx`DELETE FROM interview.slot_claim WHERE claim_key=${'reschedule:'+hold.id} OR starts_with(claim_key,${'reschedule:'+hold.id+':participant:'})`;
      await tx`UPDATE interview.slot_claim SET claim_key=replace(claim_key,${'reservation:'+hold.reservation_id},${'retired:'+hold.id}) WHERE claim_key=${'reservation:'+hold.reservation_id} OR starts_with(claim_key,${'reservation:'+hold.reservation_id+':participant:'})`;
      await tx`UPDATE interview.reservation SET interviewer_id=${hold.interviewer_id},starts_at=${hold.starts_at.toISOString()},ends_at=${hold.ends_at.toISOString()},blocks_until=${new Date(hold.ends_at.getTime()+interviewBufferForWeek(week.week_start)*60000).toISOString()},calendar_id='primary',calendar_event_id=${event.id},calendar_operation_key=${key},meet_url=${event.meetUrl},conflict_reason=NULL,revision=revision+1,updated_at=now() WHERE id=${hold.reservation_id}`;
      await tx`UPDATE interview.invitation SET expires_at=GREATEST(expires_at,${new Date(hold.ends_at.getTime()+2*86400000).toISOString()}::timestamptz) WHERE id=(SELECT invitation_id FROM interview.reservation WHERE id=${hold.reservation_id})`;
      await tx`UPDATE interview.reschedule_request SET state='completed',updated_at=now() WHERE id=${hold.id}`;
      await tx`INSERT INTO interview.integration_outbox(operation_key,provider,action,object_id) VALUES(${'reschedule-cleanup-old:'+hold.id},'google_calendar','reschedule_cleanup_old',${hold.id}) ON CONFLICT DO NOTHING`;
      const messages=await tx<{id:string}[]>`INSERT INTO interview.message(operation_key,recipient_ref,kind,campus,object_id,payload) VALUES(${'interview-mail:reschedule:'+hold.id},'synthetic@example.invalid','confirmation',${hold.campus},${hold.reservation_id},${tx.json({kind:'confirmation',campus:hold.campus,startsAt:hold.starts_at.toISOString(),meetUrl:event.meetUrl})}) ON CONFLICT(operation_key) DO UPDATE SET operation_key=EXCLUDED.operation_key RETURNING id`;
      await tx`INSERT INTO interview.integration_outbox(operation_key,provider,action,object_id) VALUES(${'interview-mail:reschedule:'+hold.id},'gmail','send_message',${messages[0].id}) ON CONFLICT DO NOTHING`;
      await tx`INSERT INTO interview.integration_outbox(operation_key,provider,action,object_id) SELECT ${'interview-notion:reschedule:'+hold.id},'notion','sync_interview',${hold.reservation_id} FROM interview.notion_staging_binding b JOIN interview.reservation r ON b.invitation_id=r.invitation_id WHERE r.id=${hold.reservation_id} AND b.campus=r.campus ON CONFLICT DO NOTHING`;
      await tx`INSERT INTO interview.audit_event(actor_ref,action,object_type,object_id,outcome,metadata) VALUES('applicant','reschedule','reservation',${hold.reservation_id},'replacement_confirmed',${tx.json({requestId:hold.id,originalStartsAt:original.starts_at.toISOString(),originalInterviewerId:original.interviewer_id})})`;
    });
    return {state:'done',externalId:event.id};
  }catch(error){return error instanceof InterviewCalendarProviderError?{state:'retry',errorCode:error.code}:{state:'reconcile_required',errorCode:'reschedule_unknown_outcome'};}
}
