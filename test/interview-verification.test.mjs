import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadInterviewModule} from './interview-test-loader.mjs';
const secret=loadInterviewModule('interview-secrets');
function setup(){Object.assign(process.env,{VERCEL_ENV:'preview',INTERVIEW_BOOKING_ENABLED:'true',INTERVIEW_AUTH_SECRET:'s'.repeat(40),INTERVIEW_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,8).toString('base64')});}
test('management capabilities are authenticated encryption with object binding',()=>{
  setup();const sealed=secret.sealInterviewSecret('private-token','invitation:one');assert.equal(secret.openInterviewSecret(sealed,'invitation:one'),'private-token');assert.throws(()=>secret.openInterviewSecret(sealed,'invitation:two'));assert.equal(JSON.stringify(sealed).includes('private-token'),false);
});
test('five wrong verification attempts commit, lock out, and never mark verified',async()=>{
  setup();let attempts=0,verified=false;
  const query=async(strings,...args)=>{const sql=strings.join('?');
    if(sql.includes('SELECT i.id,c.verification_hash'))return [{id:'invite',verification_hash:createHash('sha256').update('invite:123456').digest('hex'),verification_attempts:attempts}];
    if(sql.includes('verification_attempts=verification_attempts+1'))attempts++;
    if(sql.includes('email_verified_at=now()'))verified=true;
    return [];
  };query.begin=async(fn)=>fn(query);
  const service=loadInterviewModule('interview-invitations',{'./interview-db':{requireInterviewStagingBooking:()=>{},interviewDatabase:()=>query}});
  for(let i=0;i<7;i++)await assert.rejects(service.verifyInterviewEmail('a'.repeat(43),'000000'),/invalid_verification/);
  assert.equal(attempts,5);assert.equal(verified,false);
  await assert.rejects(service.verifyInterviewEmail('a'.repeat(43),'123456'),/invalid_verification/);
});
test('correct verification consumes the code and commits verified identity',async()=>{
  setup();let consumed=false,verified=false;
  const query=async(strings)=>{const sql=strings.join('?');
    if(sql.includes('SELECT i.id,c.verification_hash'))return [{id:'invite',verification_hash:consumed?null:createHash('sha256').update('invite:123456').digest('hex'),verification_attempts:0}];
    if(sql.includes('email_verified_at=now()'))verified=true;
    if(sql.includes('verification_hash=NULL'))consumed=true;return [];
  };query.begin=async(fn)=>fn(query);
  const service=loadInterviewModule('interview-invitations',{'./interview-db':{requireInterviewStagingBooking:()=>{},interviewDatabase:()=>query}});
  await service.verifyInterviewEmail('a'.repeat(43),'123456');assert.equal(verified,true);assert.equal(consumed,true);
  await assert.rejects(service.verifyInterviewEmail('a'.repeat(43),'123456'),/invalid_verification/);
});
