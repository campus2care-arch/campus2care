import test from 'node:test';
import assert from 'node:assert/strict';
import {loadInterviewModule} from './interview-test-loader.mjs';
function fixture(){
  const writes=[];
  const tx=async(strings,...args)=>{const sql=strings.join('?');writes.push({sql,args});if(sql.includes('INSERT INTO interview.interviewer'))return [{id:'interviewer'}];return [];};
  tx.begin=fn=>fn(tx);tx.json=value=>value;
  return {writes,service:loadInterviewModule('interview-roster',{'./interview-auth':{authorizedRole:email=>email==='bob@campus2care.org'?'ea':null},'./interview-db':{interviewDatabase:()=>tx}})};
}
const settings={email:'bob@campus2care.org',displayName:'Bob',active:true,campuses:['BU','BC'],weeklyCapacity:10};
test('roster management requires a verified identity and valid capacity/campuses',()=>{
  const {service}=fixture();
  assert.deepEqual(service.validateInterviewerSettings({...settings,email:' BOB@CAMPUS2CARE.ORG '}),settings);
  for(const change of [{email:'unknown@campus2care.org'},{weeklyCapacity:0},{weeklyCapacity:101},{campuses:[]},{campuses:['BU','BU']},{campuses:['NY']},{displayName:''},{active:'true'}])assert.throws(()=>service.validateInterviewerSettings({...settings,...change}));
});
test('roster edits preserve weekly responses and reservations while flagging affected bookings',async()=>{
  process.env.VERCEL_ENV='preview';const {service,writes}=fixture();
  assert.equal((await service.saveInterviewerSettings({...settings,active:false},'president@campus2care.org')).id,'interviewer');
  assert.ok(writes.some(w=>w.sql.includes("conflict_reason='interviewer_settings_changed'")));
  assert.ok(writes.some(w=>w.sql.includes('interview.audit_event')));
  assert.ok(writes.every(w=>!w.sql.includes('DELETE')&&!w.sql.includes('UPDATE interview.interviewer_week')&&!w.sql.includes("status='canceled'")));
});
test('production roster edits fail before any database call',async()=>{
  process.env.VERCEL_ENV='production';const {service,writes}=fixture();
  await assert.rejects(service.saveInterviewerSettings(settings,'admin'),/staging_only/);assert.equal(writes.length,0);
});
