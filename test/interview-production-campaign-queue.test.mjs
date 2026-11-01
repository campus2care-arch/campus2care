import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {loadInterviewModule} from "./interview-test-loader.mjs";
const secret="synthetic-auth-key-for-campaign-integration-test";
const email="fake-candidate@example.edu";
const hmac=createHmac("sha256",secret).update("recipient:"+email).digest("hex");
const pageId="10000000000000000000000000000001";
const manifestId="11111111-1111-1111-1111-111111111111",slotId="22222222-2222-2222-2222-222222222222";
const runKey="applicant_friday:2026-10-30",now=new Date("2026-10-30T19:00:00Z");
function fixture(open=true){
 const writes=[],state={recipient:"approved"};
 const row={manifest_id:manifestId,run_key:runKey,digest:"a".repeat(64),
 approved_by:"president@campus2care.org",expires_at:new Date("2026-10-31T19:00:00Z"),
 expected_count:1,state:"approved",campus:"BU",page_id:pageId,
 recipient_hmac:hmac,recipient_state:"approved"};
 const db=async()=>[];
 db.unsafe=async (query,args=[])=>{
   if(query.startsWith("SELECT s.id FROM interview.schedule_slot")){
     assert.match(query,/lead.active/);
     assert.match(query,/JOIN interview.slot_claim/);
     return open?[{id:slotId}]:[];
   }
   if(query.startsWith("SELECT m.id AS manifest_id"))
     return [{...row,recipient_state:state.recipient}];
   if(query.startsWith("SELECT c.email FROM interview.invitation"))return [];
   if(query.includes("SELECT pg_advisory_xact_lock"))return [];
   if(query.includes("SELECT c.manifest_id AS id"))return [{id:manifestId}];
   if(query.startsWith("SELECT (EXISTS("))return [{blocked:false}];
   if(query.startsWith("SELECT state,sent_at,created_at"))return [];
   writes.push({query,args});
   if(query.includes("UPDATE interview.applicant_campaign_recipient"))state.recipient="queued";
   return [];
 };
 db.begin=async callback=>callback(db);
 return {db,writes,state};
}
test("queue permits approved invitations even with no currently open slot",async()=>{
 const queue=loadInterviewModule("interview-production-campaign-queue",{
   "./interview-dispatch-policy":{dueInterviewDispatches:()=>[{runKey,kind:"applicant_friday"}],
      routineOutreachDecision:()=>"eligible",outreachHistoryLookbackHours:()=>168},
   "./interview-production-campaign-crypto":{sealProductionCampaignToken:()=>({iv:"x",tag:"y",ciphertext:"z"})},
 });
 const f=fixture(false);
 const previous=process.env.INTERVIEW_AUTH_SECRET,oldFetch=globalThis.fetch;
 process.env.INTERVIEW_AUTH_SECRET=secret;
 globalThis.fetch=async url=>{
   assert.equal(url,"https://api.notion.com/v1/pages/"+pageId);
   return Response.json({id:pageId,properties:{Email:{type:"email",email}}});
 };
 try{
   const result=await queue.queueApprovedApplicantCampaign(now,{
     db:f.db,gate:()=>{},verify:async()=>true,teams:async()=>[]});
   assert.equal(result.queued,1);
   assert.ok(!result.blocked.includes("applicant_friday:no_bookable_team"));
   assert.ok(f.writes.some(x=>x.query.startsWith("INSERT INTO interview.invitation")));
 }finally{
   globalThis.fetch=oldFetch;
   if(previous===undefined)delete process.env.INTERVIEW_AUTH_SECRET;
   else process.env.INTERVIEW_AUTH_SECRET=previous;
 }
});
test("approved exact recipient creates invitation, attempt, encrypted message, and outbox atomically",async()=>{
 const queue=loadInterviewModule("interview-production-campaign-queue",{
   "./interview-dispatch-policy":{dueInterviewDispatches:()=>[{runKey,kind:"applicant_friday"}],
     routineOutreachDecision:()=>"eligible",outreachHistoryLookbackHours:()=>168},
   "./interview-production-campaign-crypto":{sealProductionCampaignToken:()=>({iv:"iv",tag:"tag",ciphertext:"sealed"})},
 });
 const before=process.env.INTERVIEW_AUTH_SECRET,oldFetch=globalThis.fetch;
 process.env.INTERVIEW_AUTH_SECRET=secret;
 let fetched=0,verified=0;
 globalThis.fetch=async url=>{
   fetched++;assert.equal(url,"https://api.notion.com/v1/pages/"+pageId);
   return Response.json({id:pageId,properties:{Email:{type:"email",email}}});
 };
 try{
   const f=fixture(true);
   const ready=[{id:slotId,approvedBy:"president@campus2care.org",campus:"BU",
     startsAt:"2026-11-02T15:00:00.000Z",participants:[
       {id:"a",email:"lead@campus2care.org",role:"lead",available:true},
       {id:"b",email:"shadow@campus2care.org",role:"shadow",available:true}]}];
   const deps={db:f.db,gate:()=>{},verify:async x=>{
     verified++;assert.equal(x.campus,"BU");assert.equal(x.email,email);
   },teams:async()=>ready};
   const one=await queue.queueApprovedApplicantCampaign(now,deps);
   assert.equal(one.queued,1);
   assert.equal(fetched,1);assert.equal(verified,1);
   assert.ok(f.writes.some(x=>x.query.startsWith("INSERT INTO interview.invitation")));
   assert.ok(f.writes.some(x=>x.query.startsWith("INSERT INTO interview.applicant_contact")));
   assert.ok(f.writes.some(x=>x.query.startsWith("INSERT INTO interview.outreach_attempt")));
   const message=f.writes.find(x=>x.query.startsWith("INSERT INTO interview.message"));
   assert.ok(message);
   assert.ok(message.args.some(x=>typeof x==="string" && x.includes("sealed")));
   assert.ok(f.writes.some(x=>x.query.startsWith("INSERT INTO interview.integration_outbox")));
   const again=await queue.queueApprovedApplicantCampaign(now,deps);
   assert.equal(again.queued,0);
   assert.equal(fetched,1);
 }finally{
   globalThis.fetch=oldFetch;
   if(before===undefined)delete process.env.INTERVIEW_AUTH_SECRET;
   else process.env.INTERVIEW_AUTH_SECRET=before;
 }
});
