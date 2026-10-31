import {NextRequest} from 'next/server';
import {interviewAdminGuard,interviewPrivateReply} from '../../../../../lib/interview-admin-api';
import {interviewDatabase} from '../../../../../lib/interview-db';
import {readInterviewTeams} from '../../../../../lib/interview-teams';
import {readInterviewerFreeBusy,calendarSlotIsFree} from '../../../../../lib/interview-calendar-freebusy';
import {googleProviderAccessToken} from '../../../../../lib/interview-google-provider-auth';
export const runtime='nodejs';
export const maxDuration=60;
export async function POST(request:NextRequest){
 const guard=interviewAdminGuard(request);if(guard)return guard;
 try{
  const db=interviewDatabase(),teams=(await readInterviewTeams(db)).filter(t=>t.approvedBy==='president@campus2care.org');
  const emails=[...new Set(teams.flatMap(t=>t.participants.map(p=>p.email)))];
  const token=await googleProviderAccessToken('calendar');
  const reads=await Promise.all(emails.map(async email=>({email,busy:await readInterviewerFreeBusy({calendarId:email,accessToken:token,startsAt:'2026-11-02T05:00:00.000Z',endsAt:'2026-11-09T05:00:00.000Z'})})));
  const conflicts=teams.filter(team=>team.participants.some(p=>!calendarSlotIsFree(team.startsAt,new Date(Date.parse(team.startsAt)+20*60000).toISOString(),reads.find(r=>r.email===p.email)!.busy,0)));
  const result={checkedAt:new Date().toISOString(),slots:teams.length,participants:emails.length,participantAssignments:teams.reduce((n,t)=>n+t.participants.length,0),conflictingSlots:conflicts.map(t=>({id:t.id,campus:t.campus,startsAt:t.startsAt})),allCalendarsReadable:true};
  await db`INSERT INTO interview.audit_event(actor_ref,action,object_type,object_id,outcome,metadata) VALUES('president@campus2care.org','check_founder_calendars','schedule','2026-11-02',${conflicts.length?'conflicts':'clear'},${db.json(result)})`;
  return interviewPrivateReply({ok:true,...result});
 }catch{return interviewPrivateReply({ok:false,error:'participant_calendar_check_failed'},503);}
}
