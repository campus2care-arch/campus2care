import test from 'node:test';
import assert from 'node:assert/strict';
import {loadInterviewModule} from './interview-test-loader.mjs';
function fixture(valid=true){
  const calls=[];const tx=async(strings,...args)=>{const sql=strings.join('?');calls.push({sql,args});return sql.includes('SELECT recipient_hmac')&&valid?[{recipient_hmac:'a'.repeat(64)}]:[];};tx.begin=fn=>fn(tx);
  return {calls,service:loadInterviewModule('interview-invitations',{'./interview-db':{requireInterviewStagingBooking:()=>{},interviewDatabase:()=>tx}})};
}
test('opt-out suppresses cross-campus invitations without revoking or canceling an appointment',async()=>{
  const {service,calls}=fixture();await service.optOutOfInterviewOutreach('a'.repeat(43));
  assert.ok(calls.some(c=>c.sql.includes('c.opted_out_at')||c.sql.includes('SET opted_out_at')));
  assert.ok(calls.some(c=>c.sql.includes("m.kind='invitation'")));
  assert.ok(calls.some(c=>c.sql.includes("state='suppressed'")));
  assert.ok(calls.every(c=>!c.sql.includes('UPDATE interview.reservation')&&!c.sql.includes('SET revoked_at')));
});
test('invalid or expired opt-out capabilities cannot mutate another identity',async()=>{
  const f=fixture(false);await assert.rejects(f.service.optOutOfInterviewOutreach('bad'),/invalid_invitation/);assert.equal(f.calls.length,0);
  await assert.rejects(f.service.optOutOfInterviewOutreach('a'.repeat(43)),/invalid_invitation/);assert.equal(f.calls.some(c=>c.sql.trimStart().startsWith('UPDATE')),false);
});
