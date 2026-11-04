import test from 'node:test';
import assert from 'node:assert/strict';
import {loadInterviewModule} from './interview-test-loader.mjs';
const lib=loadInterviewModule('interview-self-schedule');
const teams=loadInterviewModule('interview-teams');
const week=loadInterviewModule('interview-week-choice').interviewWeekChoices().next;
const record={eaId:lib.RYAN_EMAIL,weekStart:week,status:'unavailable',confirmedAt:new Date().toISOString(),recurringWindows:[],overrides:[]};
test('self publishing requires Ryan, BC leadership, and acting for himself',()=>{
 assert.equal(lib.canPublishOwnSchedule(lib.RYAN_EMAIL,'bc_lead',false),true);
 for(const args of [['other@campus2care.org','bc_lead',false],[lib.RYAN_EMAIL,'ea',false],[lib.RYAN_EMAIL,'admin',false],[lib.RYAN_EMAIL,'bc_lead',true]])assert.equal(lib.canPublishOwnSchedule(...args),false);
 assert.throws(()=>lib.selfScheduleStarts({...record,eaId:'other@campus2care.org'}),/scope/);
 assert.throws(()=>lib.selfScheduleStarts({...record,weekStart:'2020-01-06'}),/scope/);
});
test('self approval cannot authorize another lead or campus',()=>{
 const team={approvedBy:lib.RYAN_EMAIL,campus:'BC',leadId:'self',participants:[{id:'self',email:lib.RYAN_EMAIL,role:'lead'}]};
 assert.equal(teams.isApprovedInterviewTeam(team),true);
 assert.equal(teams.isApprovedInterviewTeam({...team,campus:'BU'}),false);
 assert.equal(teams.isApprovedInterviewTeam({...team,leadId:'other'}),false);
 assert.equal(teams.isApprovedInterviewTeam({...team,participants:[{id:'self',email:'other@campus2care.org',role:'lead'}]}),false);
});
function fixture(role='lead'){
 const writes=[];
 const tx=async(parts,...values)=>{
  const sql=parts.join('?');
  if(sql.includes('FROM interview.interviewer i LEFT JOIN'))return [{id:'self',workspace_email:lib.RYAN_EMAIL,team_role:role,lead_interviewer_id:role==='shadow'?'lead':null,status:'unavailable'}];
  if(sql.includes('FROM interview.schedule_slot s WHERE'))return [
   {id:'booked',lead_id:role==='shadow'?'lead':'self',starts_at:new Date(week+'T15:00:00Z'),protected:true},
   {id:'open',lead_id:role==='shadow'?'lead':'self',starts_at:new Date(week+'T16:00:00Z'),protected:false}];
  writes.push({sql,values});return [];
 };tx.json=value=>value;
 return {tx,writes};
}
test('withdrawal removes only unbooked own slots and never reservations',async()=>{
 const f=fixture();const result=await lib.publishOwnSchedule(f.tx,'self',record);
 assert.equal(result.removed,1);
 assert.equal(f.writes.some(q=>q.values.includes('booked')),false);
 assert.equal(f.writes.filter(q=>q.sql.includes('DELETE FROM interview.schedule_slot')).length,1);
 assert.equal(f.writes.some(q=>/UPDATE interview.reservation|DELETE FROM interview.reservation|integration_outbox/.test(q.sql)),false);
});
test('shadower withdrawal preserves the lead slot and booked team',async()=>{
 const f=fixture('shadow');await lib.publishOwnSchedule(f.tx,'self',record);
 assert.equal(f.writes.some(q=>q.sql.includes('DELETE FROM interview.schedule_slot')),false);
 const withdrawal=f.writes.find(q=>q.sql.includes('DELETE FROM interview.schedule_participant'));
 assert.ok(withdrawal.sql.includes("participant_id=? AND role='shadow'"));
 assert.deepEqual(withdrawal.values,['open','self']);
 assert.equal(f.writes.some(q=>q.values.includes('booked')),false);
});
test('booking warning aborts transaction; changed appointments require another warning',async()=>{
 let committed=false;
 const start=new Date(week+'T15:00:00Z');
 const db=async(parts)=>{
  const sql=parts.join('?');
  if(sql.includes('SELECT id FROM interview.interviewer'))return [{id:'self'}];
  if(sql.includes('SELECT approval_source,revision'))return [{revision:'1',approval_source:'founder'}];
  if(sql.includes('RETURNING revision::text'))return [{revision:'2'}];
  if(sql.includes('FROM interview.reservation'))return [{id:'booking',starts_at:start,blocks_until:new Date(+start+1200000)}];
  return [];
 };db.json=v=>v;db.begin=async callback=>{const result=await callback(db);committed=true;return result;};
 const service=loadInterviewModule('interview-week-db',{'./interview-staff-db':{interviewStaffDatabase:()=>db,productionStaffEnabled:()=>true}});
 for(const acknowledgedAppointments of [undefined,[],['2099-01-01T00:00:00.000Z']]){
  await assert.rejects(service.saveAuthoritativeInterviewWeek(lib.RYAN_EMAIL,week,record,'db:1',{allowRyanFounderWeekEdit:true,acknowledgedAppointments}),error=>error.message==='booking_warning_required'&&error.appointments[0]===start.toISOString());
  assert.equal(committed,false);
 }
});
test('Ryan may publish his assigned BC lead team as a shadower, never an unrelated team',()=>{
 const team={approvedBy:lib.RYAN_EMAIL,campus:'BC',leadId:'lead',participants:[{id:'self',email:lib.RYAN_EMAIL,role:'shadow',assignedLeadId:'lead'}]};
 assert.equal(teams.isApprovedInterviewTeam(team),true);
 assert.equal(teams.isApprovedInterviewTeam({...team,leadId:'unrelated'}),false);
});
test('matching confirmed lead hours allow publication; missing lead confirmation creates no slot',async()=>{
 for(const matches of [true,false]){
  const queries=[];
  const confirmed={...record,status:'confirmed',recurringWindows:[{weekday:0,windows:[{startMinute:540,endMinute:560}]}]};
  const tx=async(parts,...values)=>{
   const sql=parts.join('?');queries.push({sql,values});
   if(sql.includes('FROM interview.interviewer i LEFT JOIN'))return [
    {id:'self',workspace_email:lib.RYAN_EMAIL,team_role:'shadow',lead_interviewer_id:'lead',status:'confirmed',confirmed_at:new Date(),effective_windows:confirmed.recurringWindows,date_overrides:[]},
    {id:'lead',workspace_email:'lead@campus2care.org',team_role:'lead',status:matches?'confirmed':'unavailable',confirmed_at:new Date(),effective_windows:confirmed.recurringWindows,date_overrides:[]}];
   if(sql.includes('INSERT INTO interview.schedule_slot'))return [{id:'new-slot'}];
   return [];
  };tx.json=v=>v;
  const result=await lib.publishOwnSchedule(tx,'self',confirmed);
  assert.equal(result.created,matches?1:0);
  assert.equal(queries.some(q=>q.sql.includes('UPDATE interview.interviewer_week')),false);
  assert.equal(queries.some(q=>q.sql.includes('INSERT INTO interview.reservation')),false);
 }
});
