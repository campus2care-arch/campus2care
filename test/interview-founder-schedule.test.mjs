import test from 'node:test';
import assert from 'node:assert/strict';
import {loadInterviewModule} from './interview-test-loader.mjs';
const input={slotId:'11111111-1111-4111-8111-111111111111',revision:'1',startsAt:'2026-11-02T14:20:00.000Z',leadEmail:'cori.miller@campus2care.org',shadowEmails:['sarah.lee@campus2care.org']};
function service(booked=false){const calls=[];const query=async(strings)=>{const sql=strings.join('?');calls.push(sql);
 if(sql.includes('FROM interview.schedule_slot WHERE id='))return [{id:input.slotId,lead_id:'cori',starts_at:new Date(input.startsAt),campus:'BU',revision:'1',approved_by:'president@campus2care.org'}];
 if(sql.includes('SELECT participant_id'))return [{participant_id:'cori'},{participant_id:'sarah'}];
 if(sql.includes('SELECT id,workspace_email'))return [{id:'cori',workspace_email:input.leadEmail,active:true,allowed_campuses:['BU']},{id:'sarah',workspace_email:input.shadowEmails[0],active:false,allowed_campuses:['BU']}];
 if(sql.includes('SELECT id FROM interview.reservation'))return booked?[{id:'booking'}]:[];
 if(sql.includes('AS date,'))return [{date:'2026-11-02',minute:560}];return [];
 };query.begin=fn=>fn(query);query.json=v=>v;
 const lib=loadInterviewModule('interview-founder-schedule',{'./interview-db':{interviewDatabase:()=>query},'./interview-auth':{authorizedRole:e=>[input.leadEmail,...input.shadowEmails].includes(e)?'ea':null}});return {lib,calls};}
test('founder correction requires president identity and preserves every booked shift',async()=>{
 process.env.VERCEL_ENV='preview';const f=service(true);
 await assert.rejects(f.lib.correctFounderShift(input,'president@campus2care.org'),/booked_shift_preserved/);
 assert.equal(f.calls.some(sql=>sql.includes('UPDATE interview.schedule_slot')),false);
 await assert.rejects(f.lib.correctFounderShift(input,'cori.miller@campus2care.org'),/founder_access_required/);
});
test('unbooked correction updates only one-off overrides, never recurring templates or reservations',async()=>{
 process.env.VERCEL_ENV='preview';const f=service();assert.deepEqual(await f.lib.correctFounderShift(input,'president@campus2care.org'),{revision:'2'});
 assert.ok(f.calls.some(sql=>sql.includes('UPDATE interview.schedule_slot')));
 assert.equal(f.calls.some(sql=>sql.includes('UPDATE interview.reservation')||sql.includes('interviewer_template')),false);
 assert.ok(f.calls.some(sql=>sql.includes("WHERE interviewer_week.approval_source='founder'")));
});
test('duplicate participants and shifts outside the approved week are rejected',()=>{
 const f=service();assert.throws(()=>f.lib.validateFounderShiftEdit({...input,shadowEmails:[input.leadEmail]}),/participant_not_authorized/);
 assert.throws(()=>f.lib.validateFounderShiftEdit({...input,startsAt:'2026-11-09T14:20:00.000Z'}),/outside_founder_week/);
});
