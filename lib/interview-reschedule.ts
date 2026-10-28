import {createHash,randomUUID} from "node:crypto";
import {interviewDatabase,requireInterviewStagingBooking,postgresConflictCode} from "./interview-db";
import {InterviewBookingError,type HoldRequest} from "./interview-booking";
import {buildInterviewSlots,mondayForDate,type WeeklyConfirmation} from "./interview-availability";
import {instantToEasternLocal,easternLocalToInstant} from "./interview-timezone";
import {calendarReadAccessEnabled,readInterviewerFreeBusy,calendarSlotIsFree} from "./interview-calendar-freebusy";
import {googleProviderAccessToken} from "./interview-google-provider-auth";

/** Reserve a replacement without changing the original appointment or its Calendar event. */
export async function requestStagingReschedule(input:HoldRequest & {reservationId:string}){
  requireInterviewStagingBooking();
  if(!/^[A-Za-z0-9_-]{32,256}$/.test(input.invitationToken??"")||!/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(input.reservationId??"")||!/^[a-f0-9-]{36}$/i.test(input.interviewerId??""))throw new InterviewBookingError("invalid_reschedule_request");
  const start=new Date(input.startsAt);
  if(!Number.isFinite(start.getTime())||start.toISOString()!==input.startsAt||start.getTime()<Date.now()+30*60000)throw new InterviewBookingError("invalid_booking_time");
  const local=instantToEasternLocal(start),week=mondayForDate(local.date);
  if(easternLocalToInstant(local.date,local.minute).getTime()!==start.getTime())throw new InterviewBookingError("invalid_booking_time");
  try{return await interviewDatabase().begin(async(tx)=>{
    const invites=await tx<{id:string;campus:"BU"|"BC"}[]>`SELECT id,campus FROM interview.invitation WHERE token_hash=${createHash('sha256').update(input.invitationToken).digest('hex')} AND expires_at>now() AND revoked_at IS NULL AND email_verified_at IS NOT NULL FOR UPDATE`;
    const invite=invites[0];if(!invite)throw new InterviewBookingError("invalid_or_unverified_invitation",403);
    const originals=await tx<{id:string;status:string;notion_page_id:string;calendar_operation_key:string|null;starts_at:Date;interviewer_id:string}[]>`SELECT id,status,notion_page_id,calendar_operation_key,starts_at,interviewer_id FROM interview.reservation WHERE id=${input.reservationId} AND invitation_id=${invite.id}`;
    const original=originals[0];if(!original?.notion_page_id.startsWith('synthetic-')||original.status!=="confirmed"||original.starts_at.getTime()<=Date.now())throw new InterviewBookingError("reschedule_requires_confirmed_booking",409);
    if(original.interviewer_id===input.interviewerId&&original.starts_at.getTime()===start.getTime())throw new InterviewBookingError("choose_different_slot",409);
    const roster=await tx<{id:string;workspace_email:string;weekly_capacity_limit:number}[]>`SELECT id,workspace_email,weekly_capacity_limit FROM interview.interviewer WHERE id=${input.interviewerId} AND active AND ${invite.campus}=ANY(allowed_campuses) FOR UPDATE`;
    const ea=roster[0];if(!ea||ea.weekly_capacity_limit<1)throw new InterviewBookingError("interviewer_unavailable",409);
    const weeks=await tx<{status:string;confirmed_at:Date|null;effective_windows:WeeklyConfirmation['recurringWindows'];date_overrides:WeeklyConfirmation['overrides']}[]>`SELECT status,confirmed_at,effective_windows,date_overrides FROM interview.interviewer_week WHERE interviewer_id=${ea.id} AND week_start=${week}::date FOR UPDATE`;
    const saved=weeks[0];if(saved?.status!=="confirmed"||!saved.confirmed_at)throw new InterviewBookingError("availability_not_confirmed",409);
    const slots=buildInterviewSlots({eaId:ea.workspace_email,weekStart:week,status:"confirmed",confirmedAt:saved.confirmed_at.toISOString(),recurringWindows:saved.effective_windows,overrides:saved.date_overrides});
    if(!slots.some(s=>s.date===local.date&&s.startMinute===local.minute))throw new InterviewBookingError("slot_not_in_confirmed_availability",409);
    const counts=await tx<{booked:number}[]>`SELECT count(*)::int AS booked FROM interview.slot_claim WHERE interviewer_id=${ea.id} AND claim_key<>${"reservation:"+original.id} AND (starts_at AT TIME ZONE 'America/New_York')::date BETWEEN ${week}::date AND (${week}::date+6)`;
    if(counts[0].booked>=ea.weekly_capacity_limit)throw new InterviewBookingError("interviewer_capacity_reached",409);
    const end=new Date(start.getTime()+20*60000);
    if(calendarReadAccessEnabled()){
      const busy=await readInterviewerFreeBusy({calendarId:ea.workspace_email,accessToken:await googleProviderAccessToken('calendar'),startsAt:start.toISOString(),endsAt:new Date(end.getTime()+5*60000).toISOString()});
      if(!calendarSlotIsFree(start.toISOString(),end.toISOString(),busy))throw new InterviewBookingError("slot_conflicts_with_calendar",409);
    }
    const id=randomUUID();
    await tx`INSERT INTO interview.reschedule_request(id,reservation_id,interviewer_id,starts_at,ends_at,original_calendar_key) VALUES(${id},${original.id},${ea.id},${start.toISOString()},${end.toISOString()},${original.calendar_operation_key??"interview-calendar:create:"+original.id})`;
    await tx`INSERT INTO interview.slot_claim(claim_key,interviewer_id,starts_at,blocks_until) VALUES(${"reschedule:"+id},${ea.id},${start.toISOString()},${new Date(end.getTime()+5*60000).toISOString()})`;
    await tx`INSERT INTO interview.integration_outbox(operation_key,provider,action,object_id) VALUES(${"interview-reschedule:create:"+id},'google_calendar','reschedule_create',${id})`;
    return {id,state:"pending",startsAt:start.toISOString()};
  });}catch(error){if(error instanceof InterviewBookingError)throw error;const conflict=postgresConflictCode(error);if(conflict)throw new InterviewBookingError(conflict,409);throw error;}
}

/** Withdraw only the pending replacement. The confirmed original is never canceled here. */
export async function abortStagingReschedule(invitationToken:string,reservationId:string){
  requireInterviewStagingBooking();
  if(!/^[A-Za-z0-9_-]{32,256}$/.test(invitationToken??'')||!/^[a-f0-9-]{36}$/i.test(reservationId??''))throw new InterviewBookingError('invalid_reschedule_request');
  return interviewDatabase().begin(async tx=>{
    const invites=await tx<{id:string}[]>`SELECT id FROM interview.invitation WHERE token_hash=${createHash('sha256').update(invitationToken).digest('hex')} AND revoked_at IS NULL AND expires_at>now() AND email_verified_at IS NOT NULL FOR UPDATE`;
    if(!invites[0])throw new InterviewBookingError('invalid_or_unverified_invitation',403);
    const originals=await tx`SELECT id FROM interview.reservation WHERE id=${reservationId} AND invitation_id=${invites[0].id} AND notion_page_id LIKE 'synthetic-%' AND status='confirmed' FOR UPDATE`;
    if(!originals.length)throw new InterviewBookingError('reschedule_requires_confirmed_booking',409);
    const holds=await tx<{id:string}[]>`UPDATE interview.reschedule_request SET state='cancel_pending',updated_at=now() WHERE reservation_id=${reservationId} AND state IN ('pending','reconcile_required') RETURNING id`;
    if(!holds[0])throw new InterviewBookingError('replacement_not_pending',409);
    await tx`INSERT INTO interview.integration_outbox(operation_key,provider,action,object_id) VALUES(${'reschedule-cleanup-new:'+holds[0].id},'google_calendar','reschedule_cleanup_new',${holds[0].id}) ON CONFLICT DO NOTHING`;
    return {id:holds[0].id,state:'cancel_pending'};
  });
}
