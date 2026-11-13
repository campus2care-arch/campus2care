import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {loadInterviewModule} from './interview-test-loader.mjs';
const {bookedInterviewAccess}=loadInterviewModule('interview-booked-link');
const invitation='11111111-1111-1111-1111-111111111111';
const reservation='22222222-2222-2222-2222-222222222222';
const tag=(parts,...args)=>({text:parts.join('?').replaceAll('::uuid',''),args});
function allowed({scope=undefined,expiry='2026-11-09T00:00:00Z',end='2026-11-12T18:20:00Z',status='confirmed',revoked=null,verified='2026-11-01',sameInvite=true,sameIdentity=true,booked=true}={}){
 const db=new DatabaseSync(':memory:');
 db.function('now',()=> '2026-11-10T18:00:00Z');
 db.exec("ATTACH DATABASE ':memory:' AS interview; CREATE TABLE interview.invitation(id,campus,notion_page_id,recipient_hmac,expires_at,revoked_at,email_verified_at); CREATE TABLE interview.reservation(id,invitation_id,campus,notion_page_id,recipient_hmac,status,ends_at);");
 db.prepare('INSERT INTO interview.invitation VALUES (?,?,?,?,?,?,?)').run(invitation,'BC','page','recipient',expiry,revoked,verified);
 if(booked)db.prepare('INSERT INTO interview.reservation VALUES (?,?,?,?,?,?,?)').run(reservation,sameInvite?invitation:'other','BC','page',sameIdentity?'recipient':'other',status,end);
 const resultFragment=bookedInterviewAccess(tag,scope);
 const fragment=resultFragment===false?{text:"false",args:[]}:resultFragment;
 const result=db.prepare(`SELECT count(*) AS total FROM interview.invitation i WHERE i.revoked_at IS NULL AND i.email_verified_at IS NOT NULL AND (i.expires_at>now() OR ${fragment.text})`).get(...fragment.args).total;
 db.close();return result===1;
}
test('expired verified original link manages its own future booking without reviving unused links',()=>{
 assert.equal(allowed(),true);
 assert.equal(allowed({scope:reservation}),true);
 assert.equal(allowed({scope:null}),false);
 assert.equal(allowed({booked:false}),false);
 assert.equal(allowed({scope:'33333333-3333-3333-3333-333333333333'}),false);
 assert.equal(allowed({sameInvite:false}),false);
 assert.equal(allowed({sameIdentity:false}),false);
});
test('revoked, unverified, failed, expired and completed appointments stay inaccessible',()=>{
 for(const patch of [{revoked:'2026-11-09'},{verified:null},{status:'failed'},{status:'expired'},
   {status:'completed',end:'2026-11-10T17:00:00Z'}])assert.equal(allowed(patch),false,JSON.stringify(patch));
 assert.equal(allowed({status:'cancel_pending'}),true);
 assert.equal(allowed({status:'canceled'}),true);
 assert.equal(allowed({expiry:'2026-11-15T00:00:00Z',booked:false,scope:null}),true);
});
test('an expired link can open a missed interview so the student can book again',()=>{
 assert.equal(allowed({end:'2026-11-10T17:59:59Z',status:'confirmed'}),true);
 assert.equal(allowed({end:'2026-11-10T18:00:00Z',status:'confirmed'}),true);
 assert.equal(allowed({end:'2026-11-10T17:00:00Z',status:'no_show',scope:null}),true);
 assert.equal(allowed({end:'2026-11-10T17:00:00Z',status:'completed',scope:null}),false);
 assert.equal(allowed({end:'2026-11-12T18:20:00Z',status:'confirmed',scope:null}),false);
});
