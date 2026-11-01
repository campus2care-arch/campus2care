import test from 'node:test';
import assert from 'node:assert/strict';
import {loadInterviewModule} from './interview-test-loader.mjs';

function setup(){
  const messages=new Set(),outbox=new Set(),audit=[];
  const appointment={id:'11111111-1111-1111-1111-111111111111',campus:'BU',
    email:'test@example.org',starts_at:new Date('2026-11-02T18:00:00Z'),
    meet_url:'https://meet.google.com/abc-defg-hij'};
  const db=async (parts,...values)=>{
    const sql=parts.join('?');
    if(sql.includes('SELECT r.id,r.campus,r.starts_at')) {
      assert.match(sql,/opted_out_at IS NULL/);
      assert.match(sql,/revoked_at IS NULL/);
      assert.match(sql,/FOR UPDATE OF r SKIP LOCKED/);
      return [appointment];
    }
    if(sql.includes('INSERT INTO interview.message')){
      const key=values[0];
      if(messages.has(key))return [];
      messages.add(key);
      return [{id:'22222222-2222-2222-2222-222222222222'}];
    }
    if(sql.includes('INSERT INTO interview.integration_outbox')){
      outbox.add(values[0]);return [];
    }
    if(sql.includes('INSERT INTO interview.audit_event')){
      audit.push(values);return [];
    }
    throw Error('unexpected database query '+sql.slice(0,100));
  };
  db.begin=callback=>callback(db);
  db.json=x=>x;
  const scheduler=loadInterviewModule('interview-production-scheduler',{
    './interview-production-launch':{productionRealConfig:env=>{
      if(env.INTERVIEW_LIVE_RELEASE_APPROVED!=='true')throw Error('release_not_approved');
    }},
    './interview-production-db':{productionInterviewDatabase:()=>{throw Error('real database forbidden');}},
    './interview-production-worker':{processProductionCanaryOutbox:async()=>{throw Error('real worker forbidden');}},
    './interview-dispatch-policy':{dueInterviewDispatches:()=>[
      {kind:'applicant_friday',runKey:'applicant_friday:2026-10-30'},
      {kind:'ea_request',runKey:'ea_request:2026-10-28'}]},
  });
  return {db,scheduler,messages,outbox,audit};
}
test('production scheduler is independently disabled until founder release and scheduler flags',()=>{
  const f=setup();
  assert.throws(()=>f.scheduler.productionSchedulerReady({
    INTERVIEW_LIVE_RELEASE_APPROVED:'false',INTERVIEW_PRODUCTION_SCHEDULER_ENABLED:'true'
  }),/release_not_approved/);
  assert.throws(()=>f.scheduler.productionSchedulerReady({
    INTERVIEW_LIVE_RELEASE_APPROVED:'true',INTERVIEW_PRODUCTION_SCHEDULER_ENABLED:'false'
  }),/production_scheduler_disabled/);
});
test('24-hour reminder is transactional/idempotent and the heartbeat does not claim campaigns ran',async()=>{
  Object.assign(process.env,{INTERVIEW_LIVE_RELEASE_APPROVED:'true',
    INTERVIEW_PRODUCTION_SCHEDULER_ENABLED:'true',
    INTERVIEW_REAL_REMINDERS_APPROVED:'true'});
  const f=setup(),now=new Date('2026-11-01T18:00:00Z');
  const worker=async()=>({claimed:1,done:1,retry:0,reconciliation:0});
  const a=await f.scheduler.runProductionInterviewScheduler(now,{db:f.db,worker});
  const b=await f.scheduler.runProductionInterviewScheduler(now,{db:f.db,worker});
  assert.equal(a.queuedReminders,1);
  assert.equal(b.queuedReminders,0);
  assert.equal(f.outbox.size,1);
  assert.equal(f.messages.size,1);
  assert.equal(f.audit.length,2);
  assert.equal(a.outcome,'healthy');
  assert.equal(a.reconciliationRequired,0);
  assert.deepEqual(a.unimplementedDispatchKinds,['applicant_friday','ea_request','staff_notifications_not_approved']);
});
test('no reminder is queued without separate notification authorization',async()=>{
  process.env.INTERVIEW_REAL_REMINDERS_APPROVED='false';
  const f=setup();
  await assert.rejects(f.scheduler.queueProductionAppointmentReminders(f.db),/reminders_not_authorized/);
  assert.equal(f.outbox.size,0);
});

test('heartbeat needs attention only when a send needs manual reconciliation',async()=>{
  Object.assign(process.env,{INTERVIEW_LIVE_RELEASE_APPROVED:'true',
    INTERVIEW_PRODUCTION_SCHEDULER_ENABLED:'true',INTERVIEW_REAL_REMINDERS_APPROVED:'false'});
  const f=setup(),now=new Date('2026-11-01T18:00:00Z');
  const worker=async()=>({claimed:1,done:0,retry:0,reconciliation:1});
  const a=await f.scheduler.runProductionInterviewScheduler(now,{db:f.db,worker});
  assert.equal(a.outcome,'needs_attention');
  assert.equal(a.reconciliationRequired,1);
  assert.ok(a.gatedDispatchKinds.includes('appointment_reminders_not_approved'));
});
