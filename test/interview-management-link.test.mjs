import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadInterviewModule} from './interview-test-loader.mjs';
const crypto=loadInterviewModule('interview-production-campaign-crypto');
const {interviewManagementLink}=loadInterviewModule('interview-management-link');
const token='a'.repeat(43),operation='campaign-invite:applicant_manual:fixture';
function fixture(){
 Object.assign(process.env,{VERCEL_ENV:'production',INTERVIEW_DATA_ENV:'production',INTERVIEW_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64'),INTERVIEW_BASE_URL:'https://www.campus2care.org'});
 const row={operation_key:operation,payload:{token:crypto.sealProductionCampaignToken(token,operation)},token_hash:createHash('sha256').update(token).digest('hex')};
 return row;
}
test('transactional management link reuses the authenticated encrypted invitation',async()=>{
 const row=fixture(),queries=[];
 const db=async(parts,...args)=>{queries.push({text:parts.join('?'),args});return [row];};
 assert.equal(await interviewManagementLink(db,'reservation'),'https://www.campus2care.org/interview#token='+token);
 assert.deepEqual(queries[0].args,['reservation']);
 assert.match(queries[0].text,/i.revoked_at IS NULL AND i.email_verified_at IS NOT NULL/);
 assert.match(queries[0].text,/m.object_id=i.id/);
 row.token_hash='bad';await assert.rejects(interviewManagementLink(db,'reservation'),/token_mismatch/);
});
test('legacy invites fall back without minting credentials; corrupt ciphertext and foreign origins fail closed',async()=>{
 fixture();assert.equal(await interviewManagementLink(async()=>[],'legacy'),undefined);
 const row=fixture();row.operation_key+='tampered';await assert.rejects(interviewManagementLink(async()=>[row],'reservation'));
 const valid=fixture();process.env.INTERVIEW_BASE_URL='https://www.campus2care.org/elsewhere';
 await assert.rejects(interviewManagementLink(async()=>[valid],'reservation'),/origin_invalid/);
});
