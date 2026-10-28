import test from 'node:test';
import assert from 'node:assert/strict';
import {loadInterviewModule} from './interview-test-loader.mjs';
function fixture({meet=true,failDelete=false,status='confirmed',active=true}={}){
 Object.assign(process.env,{VERCEL_ENV:'preview',INTERVIEW_SYNTHETIC_CALENDAR_ENABLED:'true'});
 const calls=[],external=[];
 const query=async(strings,...args)=>{
  const sql=strings.join('?');calls.push({sql,args});
  if(sql.includes('SELECT x.*'))return [{id:'hold',reservation_id:'original',interviewer_id:'ea',starts_at:new Date('2099-11-02T19:00:00Z'),ends_at:new Date('2099-11-02T19:20:00Z'),state:'pending',original_calendar_key:'original-key',notion_page_id:'synthetic-applicant',campus:'BU'}];
  if(sql.includes('SELECT status,calendar_operation_key'))return [{status,calendar_operation_key:'original-key',interviewer_id:'ea',starts_at:new Date('2099-11-02T18:00:00Z')}];
  if(sql.includes('SELECT state FROM interview.reschedule_request'))return [{state:'pending'}];
  if(sql.includes('SELECT active,weekly_capacity_limit'))return [{active,weekly_capacity_limit:10,workspace_email:'bob@campus2care.org',allowed_campuses:['BU']}];
  if(sql.includes('FROM interview.interviewer_week'))return [{status:'confirmed',confirmed_at:new Date(),week_start:'2099-11-02',effective_windows:[],date_overrides:[]}];
  if(sql.includes('count(*)'))return [{booked:0}];
  if(sql.includes('RETURNING id'))return [{id:'message'}];return [];
 };query.begin=async(fn)=>fn(query);query.json=v=>v;
 const service=loadInterviewModule('interview-reschedule-worker',{
  './interview-db':{interviewDatabase:()=>query},
  './interview-google-provider-auth':{googleProviderAccessToken:async()=> 'test-token'},
  './interview-availability':{buildInterviewSlots:()=>[{date:'2099-11-02',startMinute:840}]},
  './interview-timezone':{instantToEasternLocal:()=>({date:'2099-11-02',minute:840})},
  './interview-calendar-provider':{createSyntheticInterviewCalendarEvent:async()=>{external.push('create');return {id:'new-event',status:'confirmed',meetUrl:meet?'https://meet.google.com/abc-defg-hij':null};},cancelSyntheticInterviewCalendarEvent:async()=>{external.push('delete');if(failDelete)throw Error('provider failed');},InterviewCalendarProviderError:class extends Error{}},
 });return {service,calls,external};
}
const job={id:'job',object_id:'hold',action:'reschedule_create',provider:'google_calendar',operation_key:'test-key',attempts:1};
test('pending replacement Meet never changes or cancels the original',async()=>{const f=fixture({meet:false});assert.equal((await f.service.handleRescheduleJob(job)).state,'retry');assert.deepEqual(f.external,['create']);assert.equal(f.calls.some(c=>c.sql.includes('UPDATE interview.reservation SET')),false);});
test('replacement commits only after valid Meet and retains old claim until cleanup',async()=>{const f=fixture();assert.equal((await f.service.handleRescheduleJob(job)).state,'done');assert.deepEqual(f.external,['create']);assert.ok(f.calls.some(c=>c.sql.includes('UPDATE interview.slot_claim SET claim_key=')));assert.ok(f.calls.some(c=>c.sql.includes('UPDATE interview.reservation SET')));assert.ok(f.calls.some(c=>c.sql.includes('reschedule_cleanup_old')));});
test('offboarding or concurrent cancellation preserves original and cleans the replacement',async()=>{for(const options of [{active:false},{status:'cancel_pending'}]){const f=fixture(options);await f.service.handleRescheduleJob(job);assert.equal(f.calls.some(c=>c.sql.includes('UPDATE interview.reservation SET')),false);assert.ok(f.calls.some(c=>c.sql.includes('reschedule_cleanup_new')));}});
test('old cleanup cannot run before a replacement has committed',async()=>{const f=fixture({failDelete:true});assert.equal((await f.service.handleRescheduleJob({...job,action:'reschedule_cleanup_old'})).state,'retry');assert.deepEqual(f.external,[]);assert.equal(f.calls.some(c=>c.sql.includes('DELETE FROM interview.slot_claim')),false);});
test('reschedule request at full same-EA capacity keeps original and commits only replacement claim/outbox',async()=>{
 Object.assign(process.env,{VERCEL_ENV:'preview',INTERVIEW_BOOKING_ENABLED:'true'});
 const availability=loadInterviewModule('interview-availability'),time=loadInterviewModule('interview-timezone');
 const week=availability.mondayForDate('2099-11-02'),calls=[];
 const query=async(strings,...args)=>{const sql=strings.join('?');calls.push({sql,args});
  if(sql.includes('FROM interview.invitation'))return [{id:'invite',campus:'BU'}];
  if(sql.includes('FROM interview.reservation'))return [{id:'11111111-1111-1111-1111-111111111111',status:'confirmed',notion_page_id:'synthetic-test',calendar_operation_key:null,starts_at:time.easternLocalToInstant(week,840),interviewer_id:'22222222-2222-2222-2222-222222222222'}];
  if(sql.includes('FROM interview.interviewer_week'))return [{status:'confirmed',confirmed_at:new Date(),effective_windows:[{weekday:0,windows:[{startMinute:840,endMinute:960}]}],date_overrides:[]}];
  if(sql.includes('FROM interview.interviewer'))return [{id:'22222222-2222-2222-2222-222222222222',workspace_email:'bob@campus2care.org',weekly_capacity_limit:1}];
  if(sql.includes('count(*)'))return [{booked:0}];return [];
 };query.begin=async(fn)=>fn(query);
 const service=loadInterviewModule('interview-reschedule',{'./interview-db':{interviewDatabase:()=>query,requireInterviewStagingBooking:()=>{},postgresConflictCode:()=>null},'./interview-calendar-freebusy':{calendarReadAccessEnabled:()=>false}});
 const result=await service.requestStagingReschedule({invitationToken:'a'.repeat(43),reservationId:'11111111-1111-1111-1111-111111111111',interviewerId:'22222222-2222-2222-2222-222222222222',startsAt:time.easternLocalToInstant(week,890).toISOString()});
 assert.equal(result.state,'pending');assert.equal(calls.some(c=>c.sql.includes('UPDATE interview.reservation')),false);
 assert.ok(calls.some(c=>c.sql.includes('INSERT INTO interview.slot_claim')));assert.ok(calls.some(c=>c.sql.includes('INSERT INTO interview.integration_outbox')));
});
