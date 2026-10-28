import test from 'node:test';
import assert from 'node:assert/strict';
import {loadInterviewModule} from './interview-test-loader.mjs';
const time=loadInterviewModule('interview-timezone'),availability=loadInterviewModule('interview-availability');
function fixture({busy=false,offline=false}={}){
  Object.assign(process.env,{VERCEL_ENV:'preview',INTERVIEW_BOOKING_ENABLED:'true',INTERVIEW_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,2).toString('base64')});
  const week=availability.mondayForDate('2099-11-02'),calls=[],calendarCalls=[];
  const query=async(strings,...args)=>{
    const sql=strings.join('?');calls.push({sql,args});
    if(sql.includes('FROM interview.invitation'))return [{id:'invite',campus:'BU',notion_page_id:'synthetic-record',recipient_hmac:'a'.repeat(64)}];
    if(sql.includes('FROM interview.interviewer_week'))return [{status:'confirmed',confirmed_at:new Date(),effective_windows:[{weekday:0,windows:[{startMinute:840,endMinute:960}]}],date_overrides:[]}];
    if(sql.includes('FROM interview.interviewer'))return [{id:'11111111-1111-1111-1111-111111111111',workspace_email:'bob@campus2care.org',active:true,allowed_campuses:['BU'],weekly_capacity_limit:10}];
    if(sql.includes('count(*)'))return [{booked:0}];return [];
  };query.begin=async(fn)=>fn(query);query.json=(v)=>v;
  const service=loadInterviewModule('interview-booking',{
    './interview-db':{interviewDatabase:()=>query,requireInterviewStagingBooking:()=>{},postgresConflictCode:()=>null},
    './interview-google-provider-auth':{googleProviderAccessToken:async()=> 'synthetic-token'},
    './interview-calendar-freebusy':{calendarReadAccessEnabled:()=>true,readInterviewerFreeBusy:async(input)=>{calendarCalls.push(input);if(offline)throw Error('calendar_freebusy_unavailable');return busy?[{start:input.startsAt,end:input.endsAt}]:[];},calendarSlotIsFree:()=>!busy},
  });
  return {service,calls,calendarCalls,input:{invitationToken:'a'.repeat(43),interviewerId:'11111111-1111-1111-1111-111111111111',startsAt:time.easternLocalToInstant(week,840).toISOString()}};
}
test('booking rechecks only the assigned EA calendar including its buffer',async()=>{
  const f=fixture();const held=await f.service.createStagingInterviewHold(f.input);
  assert.equal(held.status,'calendar_pending');assert.equal(f.calendarCalls.length,1);assert.equal(f.calendarCalls[0].calendarId,'bob@campus2care.org');
  assert.equal(Date.parse(f.calendarCalls[0].endsAt)-Date.parse(f.calendarCalls[0].startsAt),25*60000);
  assert.ok(f.calls.some(c=>c.sql.includes('INSERT INTO interview.reservation')));assert.ok(f.calls.some(c=>c.sql.includes('INSERT INTO interview.integration_outbox')));
});
test('busy or unavailable shared calendar fails closed before reservation creation',async()=>{
  for(const options of [{busy:true},{offline:true}]){
    const f=fixture(options);await assert.rejects(f.service.createStagingInterviewHold(f.input),/slot_conflicts_with_calendar|calendar_freebusy_unavailable/);
    assert.equal(f.calls.some(c=>c.sql.includes('INSERT INTO interview.reservation')),false);
  }
});
