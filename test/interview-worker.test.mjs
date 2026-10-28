import test from 'node:test';
import assert from 'node:assert/strict';
import {loadInterviewModule} from './interview-test-loader.mjs';
function fixture({meetUrl='https://meet.google.com/abc-defg-hij',status='calendar_pending',processing=false,crash=false}={}){
  process.env.VERCEL_ENV='preview';process.env.INTERVIEW_SYNTHETIC_CALENDAR_ENABLED='true';
  const calls=[];let canceled=0;
  const query=async(strings,...args)=>{
    const sql=strings.join('?');calls.push({sql,args});
    if(sql.includes('SELECT id,status,notion_page_id'))return [{id:'reservation',status,notion_page_id:'synthetic-applicant',campus:'BU',starts_at:new Date('2026-11-02T19:00:00Z'),ends_at:new Date('2026-11-02T19:20:00Z'),calendar_event_id:null}];
    if(sql.includes('SELECT status FROM'))return [{status}];
    if(sql.includes("state='processing'"))return processing?[{id:'create'}]:[];
    if(sql.includes('RETURNING id'))return [{id:'message'}];
    return [];
  };query.begin=async(fn)=>fn(query);query.json=(x)=>x;
  const service=loadInterviewModule('interview-worker',{
    './interview-db':{interviewDatabase:()=>query},
    './interview-google-provider-auth':{googleProviderAccessToken:async()=> 'synthetic-token'},
    './interview-calendar-provider':{createSyntheticInterviewCalendarEvent:async()=>{if(crash)throw Error('unknown');return {id:'event',status:'confirmed',meetUrl};},cancelSyntheticInterviewCalendarEvent:async()=>{canceled++;},InterviewCalendarProviderError:class extends Error{}},
  });
  return {module:service,calls,canceled:()=>canceled};
}
const job={id:'job',operation_key:'interview-calendar:create:reservation',provider:'google_calendar',action:'create_event',object_id:'reservation',attempts:1};
test('pending Meet records the event but never queues confirmation',async()=>{
  const f=fixture({meetUrl:null});assert.equal((await f.module.handleInterviewOutboxJob(job)).state,'retry');
  assert.equal(f.calls.some(c=>c.sql.includes('INSERT INTO interview.message')),false);
  assert.ok(f.calls.some(c=>c.sql.includes('calendar_event_id')));
});
test('ready Meet confirms and transactionally enqueues exactly keyed notification',async()=>{
  const f=fixture();assert.equal((await f.module.handleInterviewOutboxJob(job)).state,'done');
  const msg=f.calls.find(c=>c.sql.includes('INSERT INTO interview.message'));assert.equal(msg.args[0],'interview-mail:confirmation:reservation');
});
test('cancellation cannot overtake in-flight creation',async()=>{
  const f=fixture({processing:true,status:'cancel_pending'});
  assert.equal((await f.module.handleInterviewOutboxJob({...job,action:'cancel_event'})).errorCode,'calendar_creation_in_progress');assert.equal(f.canceled(),0);
});
test('cancellation holds database status until provider acknowledgment',async()=>{
  const f=fixture({status:'cancel_pending'});assert.equal((await f.module.handleInterviewOutboxJob({...job,action:'cancel_event'})).state,'done');assert.equal(f.canceled(),1);
  assert.ok(f.calls.some(c=>c.sql.includes("status='canceled'")));
});
test('unknown provider crash is quarantined',async()=>{
  const f=fixture({crash:true});assert.equal((await f.module.handleInterviewOutboxJob(job)).state,'reconcile_required');
  assert.equal(f.calls.some(c=>c.sql.includes('INSERT INTO interview.message')),false);
});
