import test from 'node:test';
import assert from 'node:assert/strict';
import {loadInterviewModule} from './interview-test-loader.mjs';
function fixture(){
  const queries=[],keys=new Set();const tx=async(strings,...args)=>{const sql=strings.join('?');queries.push({sql,args});
    if(sql.includes('SELECT r.id'))return [{id:'booking',campus:'BC',starts_at:new Date('2099-11-02T19:00:00Z'),meet_url:'https://meet.google.com/abc-defg-hij',email:'bc@example.invalid'}];
    if(sql.includes('INSERT INTO interview.message')){if(keys.has(args[0]))return [];keys.add(args[0]);return [{id:'message'}];}return [];
  };tx.begin=fn=>fn(tx);tx.json=v=>v;
  return {queries,service:loadInterviewModule('interview-reminders',{'./interview-db':{interviewDatabase:()=>tx}})};
}
test('appointment reminders queue once and require confirmed future synthetic bookings with no opt-out',async()=>{
  Object.assign(process.env,{VERCEL_ENV:'preview',INTERVIEW_SYNTHETIC_DISPATCH_ENABLED:'true'});
  const {service,queries}=fixture();assert.equal(await service.queueSyntheticAppointmentReminders(),1);assert.equal(await service.queueSyntheticAppointmentReminders(),0);
  assert.match(queries[0].sql,/status='confirmed'/);assert.match(queries[0].sql,/24 hours/);assert.match(queries[0].sql,/30 minutes/);assert.match(queries[0].sql,/opted_out_at IS NULL/);
  assert.equal(queries.filter(q=>q.sql.includes('INSERT INTO interview.integration_outbox')).length,1);
});
test('production reminder processing fails before DB access',async()=>{
  process.env.VERCEL_ENV='production';const {service,queries}=fixture();await assert.rejects(service.queueSyntheticAppointmentReminders(),/disabled/);assert.equal(queries.length,0);
});
test('appointment reminders require a Meet link and include Eastern time',()=>{
  const service=loadInterviewModule('interview-email');const message={operationKey:'reminder:test:001',recipient:'test@example.invalid',kind:'appointment_reminder',startsAt:'2026-11-02T19:00:00.000Z',meetUrl:'https://meet.google.com/abc-defg-hij'};
  assert.match(service.renderInterviewMessage(message).text,/2:00 PM Eastern Time/);
  assert.throws(()=>service.renderInterviewMessage({...message,meetUrl:null}),/requires_meet/);
});
