import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadInterviewModule} from './interview-test-loader.mjs';
const slots=JSON.parse(readFileSync(new URL('../lib/interview-approved-week.json',import.meta.url),'utf8'));
const availability=loadInterviewModule('interview-availability');
const timezone=loadInterviewModule('interview-timezone');
const policy=loadInterviewModule('interview-week-policy');
test('approved sheet has exactly 31 BU and 22 BC slots, including independent Sunday teams',()=>{
 assert.equal(slots.filter(s=>s.campus==='BU').length,31);assert.equal(slots.filter(s=>s.campus==='BC').length,22);
 assert.equal(slots.filter(s=>s.date==='2026-11-08'&&s.time==='10:00').length,2);
 assert.ok(slots.filter(s=>s.campus==='BC').every(s=>s.participants[0]==='president@campus2care.org'&&s.participants[1]==='ryan.daves@campus2care.org'));
 const identities=slots.map(s=>s.participants[0]+s.date+s.time);assert.equal(new Set(identities).size,53);
});
test('each approved participant has nonoverlapping exact starts, with zero buffer only this week',()=>{
 const byPerson=new Map();
 for(const s of slots)for(const email of s.participants){const list=byPerson.get(email)??[];list.push(s);byPerson.set(email,list);}
 for(const[email,assigned]of byPerson){
  const recurringWindows=Array.from({length:7},(_,weekday)=>({weekday,windows:assigned.filter(s=>(new Date(s.date+'T12:00:00Z').getUTCDay()+6)%7===weekday).map(s=>{const[h,m]=s.time.split(':').map(Number);return{startMinute:h*60+m,endMinute:h*60+m+20};}).sort((a,b)=>a.startMinute-b.startMinute)}));
  const generated=availability.buildInterviewSlots({eaId:email,weekStart:'2026-11-02',status:'confirmed',confirmedAt:new Date().toISOString(),recurringWindows,overrides:[]});
  assert.equal(generated.length,assigned.length,email);
  assert.deepEqual(generated.map(s=>s.date+':'+s.startMinute).sort(),assigned.map(s=>{const[h,m]=s.time.split(':').map(Number);return s.date+':'+(h*60+m);}).sort());
 }
 assert.equal(policy.interviewBufferForWeek('2026-11-02'),0);assert.equal(policy.interviewBufferForWeek('2026-11-09'),5);
 assert.equal(timezone.easternLocalToInstant('2026-11-02',540).toISOString(),'2026-11-02T14:00:00.000Z');
});
test('withdrawing a shadower pauses the assigned team without offering that person as a lead',async()=>{
 const query=async()=>[{campus:'BU',lead_id:'cori',starts_at:new Date('2026-11-02T14:20:00Z'),participant_id:'sarah',workspace_email:'sarah.lee@campus2care.org',display_name:'Sarah Lee',role:'shadow',status:'unavailable',confirmed_at:new Date(),effective_windows:[],date_overrides:[]}];
 const service=loadInterviewModule('interview-teams');const teams=await service.readInterviewTeams(query);
 assert.equal(teams[0].leadId,'cori');assert.equal(teams[0].participants[0].available,false);assert.equal(teams[0].participants[0].role,'shadow');
});
