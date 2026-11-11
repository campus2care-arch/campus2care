import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {loadInterviewModule} from './interview-test-loader.mjs';
const token='a'.repeat(43),invite='11111111-1111-1111-1111-111111111111',id='22222222-2222-2222-2222-222222222222';
const mocks={
 './interview-production-launch':{productionRealConfig:()=>({}),productionRealEnabled:()=>true,assertProductionBookingIdentity:()=>{}},
 './interview-production-canary':{productionCanaryConfig:()=>({}),assertProductionCanaryIdentity:()=>{}},
 './interview-production-db':{productionInterviewDatabase:()=>{throw Error('real database forbidden');}},
 './interview-production-booking':{ProductionBookingError:class extends Error{constructor(code){super(code);}}},
};
const service=loadInterviewModule('interview-production-public',mocks);
const cancel=loadInterviewModule('interview-production-cancellation',mocks);
function database({revoked=false,verified=true}={}){
 const sqlite=new DatabaseSync(':memory:');sqlite.function('now',()=> '2026-11-10T18:00:00Z');
 sqlite.exec(`ATTACH DATABASE ':memory:' AS interview;
 CREATE TABLE interview.invitation(id,campus,notion_page_id,recipient_hmac,token_hash,expires_at,revoked_at,email_verified_at);
 CREATE TABLE interview.applicant_contact(invitation_id,email,opted_out_at);
 CREATE TABLE interview.reservation(id,invitation_id,campus,notion_page_id,recipient_hmac,starts_at,ends_at,status,meet_url,revision,updated_at,created_at DEFAULT 1);
 CREATE TABLE interview.reschedule_request(id,reservation_id,state,starts_at,created_at DEFAULT 1);
 CREATE TABLE interview.integration_outbox(id,object_id,state,provider,action,operation_key UNIQUE,last_error_code,updated_at);
 CREATE TABLE interview.message(id,object_id,kind,state);
 `);
 sqlite.prepare('INSERT INTO interview.invitation VALUES(?,?,?,?,?,?,?,?)').run(invite,'BC','page','recipient',createHash('sha256').update(token).digest('hex'),'2026-11-09T18:00:00Z',revoked?'2026-11-09':null,verified?'2026-11-01':null);
 sqlite.prepare('INSERT INTO interview.applicant_contact VALUES(?,?,?)').run(invite,'volunteer@example.invalid',null);
 sqlite.prepare('INSERT INTO interview.reservation(id,invitation_id,campus,notion_page_id,recipient_hmac,starts_at,ends_at,status,meet_url,revision,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,invite,'BC','page','recipient','2026-11-12T18:00:00Z','2026-11-12T18:20:00Z','confirmed','https://meet.google.com/abc-defg-hij',1,null);
 const db=(parts,...args)=>{
  const parameters=[];
  function render(parts,args){return parts.reduce((q,part,index)=>{
    if(index===0)return part;
    const arg=args[index-1];
    if(arg&&typeof arg==='object'&&arg.fragment)return q+render(arg.parts,arg.args)+part;
    parameters.push(typeof arg==='boolean'?Number(arg):arg);return q+'?'+part;
  },'');}
  return {fragment:true,parts,args,then(resolve,reject){
    try{
      const sql=render(parts,args).replaceAll('::uuid','').replace(/FOR UPDATE(?: OF [a-z,]+)?/g,'');
      const rows=sqlite.prepare(sql).all(...parameters).map(row=>{
        for(const key of ['starts_at','ends_at'])if(row[key])row[key]=new Date(row[key]);
        if('can_book' in row)row.can_book=!!row.can_book;
        return row;
      });resolve(rows);
    }catch(error){reject(error);}
  }};
 };
 db.begin=async action=>action(db);
 return {db,sqlite};
}
test('expired original link reads its appointment and cancels without releasing claims or permitting a new booking',async()=>{
 const f=database();try{
  const status=await service.readLiveInterviewStatus(token,{db:f.db});
  assert.equal(status.booking.status,'confirmed');assert.equal(status.canBook,false);
  await assert.rejects(service.readLiveInterviewSlots(token,undefined,{db:f.db}),/invalid_or_unverified_invitation/);
  // A real replacement request passes authorization and reaches its separate live eligibility check.
  await assert.rejects(service.readLiveInterviewSlots(token,id,{db:f.db,verify:async()=>{throw Error('eligible-for-replacement-check');}}),/eligible-for-replacement-check/);
  assert.equal((await cancel.cancelProductionCanaryBooking(token,id,f.db)).status,'cancel_pending');
  assert.equal(f.sqlite.prepare('SELECT status FROM interview.reservation').get().status,'cancel_pending');
  assert.equal(f.sqlite.prepare('SELECT action FROM interview.integration_outbox').get().action,'cancel_event');
  assert.equal((await service.readLiveInterviewStatus(token,{db:f.db})).booking.status,'cancel_pending');
  f.sqlite.exec("UPDATE interview.reservation SET status='canceled'");
  const canceled=await service.readLiveInterviewStatus(token,{db:f.db});
  assert.equal(canceled.booking.status,'canceled');assert.equal(canceled.canBook,false);
 }finally{f.sqlite.close();}
});
test('expired revoked or unverified links cannot read or cancel an appointment',async()=>{
 for(const options of [{revoked:true},{verified:false}]){
  const f=database(options);try{
   await assert.rejects(service.readLiveInterviewStatus(token,{db:f.db}),/invalid_or_unverified_invitation/);
   await assert.rejects(cancel.cancelProductionCanaryBooking(token,id,f.db),/booking_not_found/);
   assert.equal(f.sqlite.prepare('SELECT status FROM interview.reservation').get().status,'confirmed');
  }finally{f.sqlite.close();}
 }
});
