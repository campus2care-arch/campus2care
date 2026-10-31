import test from "node:test";
import assert from "node:assert/strict";
import {loadInterviewModule} from "./interview-test-loader.mjs";

test("applicant campaign dispatch refuses production even with individual send flag alone",()=>{
 const mod=loadInterviewModule("interview-production-campaign-queue",{
   "./interview-production-launch":{productionRealConfig:env=>{
     if(env.VERCEL_ENV!=="production"||env.INTERVIEW_LIVE_RELEASE_APPROVED!=="true")
       throw Error("live_release_disabled");
   }},
 });
 assert.throws(()=>mod.applicantCampaignSendingAuthorized({
   VERCEL_ENV:"preview",INTERVIEW_LIVE_RELEASE_APPROVED:"false",
   INTERVIEW_PRODUCTION_APPLICANT_CAMPAIGNS_ENABLED:"true",
   INTERVIEW_REAL_APPLICANT_SENDS_APPROVED:"true"
 }),/live_release_disabled/);
 assert.throws(()=>mod.applicantCampaignSendingAuthorized({
   VERCEL_ENV:"production",INTERVIEW_LIVE_RELEASE_APPROVED:"true",
   INTERVIEW_PRODUCTION_APPLICANT_CAMPAIGNS_ENABLED:"false",
   INTERVIEW_REAL_APPLICANT_SENDS_APPROVED:"true"
 }),/not_authorized/);
 assert.throws(()=>mod.applicantCampaignSendingAuthorized({
   VERCEL_ENV:"production",INTERVIEW_LIVE_RELEASE_APPROVED:"true",
   INTERVIEW_PRODUCTION_APPLICANT_CAMPAIGNS_ENABLED:"true",
   INTERVIEW_REAL_APPLICANT_SENDS_APPROVED:"false"
 }),/not_authorized/);
});
test("Gmail sender does not contact Gmail without independently authorized campaign",async()=>{
 const mod=loadInterviewModule("interview-production-campaign-mail",{
   "./interview-production-campaign-queue":{applicantCampaignSendingAuthorized:()=>{
     throw Error("campaign_sending_not_authorized");
   }},
 });
 let called=false;
 await assert.rejects(mod.sendProductionCampaignInvitation({
   operationKey:"campaign-invite:applicant_friday:2026-10-30:11111111-1111-1111-1111-111111111111",
   campus:"BU",pageId:"a".repeat(32),email:"nobody@example.edu",token:"a".repeat(43)
 },async()=>{called=true;throw Error("network call forbidden");}),/not_authorized/);
 assert.equal(called,false);
});
test("Gmail worker preserves uncertain sends as no-retry reconciliation",async()=>{
 const delivered=[];
 const token="n".repeat(43),op="campaign-invite:applicant_friday:2026-10-30:11111111-1111-1111-1111-111111111111";
 const job={id:"22222222-2222-2222-2222-222222222222",operation_key:op,
   message_id:"33333333-3333-3333-3333-333333333333",
   invitation_id:"11111111-1111-1111-1111-111111111111",
   campus:"BU",page_id:"4".repeat(32),recipient_hmac:"5".repeat(64),
   email:"person@example.edu",manifest_id:"66666666-6666-6666-6666-666666666666",
   expires_at:new Date("2099-01-01T00:00:00Z"),
   payload:{token:{ciphertext:"mock",iv:"mock",tag:"mock"}}};
 const worker=loadInterviewModule("interview-production-campaign-mail",{
   "./interview-production-campaign-queue":{applicantCampaignSendingAuthorized:()=>{}},
   "./interview-production-campaign-crypto":{openProductionCampaignToken:()=>token},
   "./interview-production-notion":{verifyLiveCanaryApplicant:async()=>true},
 });
 const record=[];
 let claimed=false;
 const sql=async (query,args=[])=>{
   record.push({query,args});
   if(query.startsWith("WITH candidate AS")){
     if(claimed)return [];
     claimed=true;return [job];
   }
   if(query.startsWith("SELECT (EXISTS("))return [{blocked:false}];
   if(query.startsWith("SELECT token_hash"))
     return [{token_hash:(await import("node:crypto")).createHash("sha256").update(token).digest("hex")}];
   if(query.includes("UPDATE interview.message SET state='reconcile_required'"))return [{id:job.message_id}];
   return [];
 };
 sql.unsafe=sql;sql.begin=async fn=>fn(sql);
 const first=await worker.processProductionCampaignOutbox(sql,2,{
   verify:async()=>true,
   deliver:async msg=>{delivered.push(msg.email);throw Error("gmail timeout");}
 });
 assert.equal(first.claimed,1);
 assert.equal(first.reconciliation,1);
 assert.equal(first.sent,0);
 assert.equal(delivered.length,1);
 assert.ok(record.some(x=>x.query.includes("state='reconcile_required'")));
 assert.ok(record.some(x=>x.query.includes("state='sending'")));
 const second=await worker.processProductionCampaignOutbox(sql,2,{
   verify:async()=>true,deliver:async()=>{throw Error("unexpected resend");}
 });
 assert.equal(second.claimed,0);
});
