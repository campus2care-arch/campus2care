import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {loadInterviewModule} from "./interview-test-loader.mjs";
const engine=loadInterviewModule("interview-production-campaign-approval");
const key="review-mock-key-strong-long-enough-for-production";
const hash=email=>createHmac("sha256",key).update("recipient:"+email).digest("hex");
const page="00000000000000000000000000000011";
const before=new Date("2026-10-29T22:00:00Z");
const applicant={campus:"BU",pageId:page,email:"volunteer@example.edu",
 archived:false,interviewDatePresent:false,reservationIdPresent:false,
 stage:"Needs Interview",nextStep:"Schedule interview",interviewStatus:"Not Scheduled",
 workflowStatus:"Application Received"};
function facts(overrides={}){
 return {reservedHmacs:new Set(),completedHmacs:new Set(),suppressedHmacs:new Set(),
 optedOutHmacs:new Set(),manuallyClearedHmacs:new Set(),historyByHmac:new Map(),
 capacityByCampus:{BU:true,BC:true},...overrides};
}
const req={runKey:"applicant_friday:2026-10-30",
 recipients:[{campus:"BU",pageId:page,recipientHmac:hash(applicant.email),
 manualReference:"Manual Gmail ledger reviewed on 2026-10-29"}]};
const review=(request=req,f=facts(),applicants=[applicant])=>engine.campaignApprovalFromSnapshot(
 request,{applicants,facts:f,authSecret:key,now:before});
test("one reviewed recipient produces immutable exact digest, not a send",()=>{
 const a=review();
 assert.equal(a.recipientCount,1);
 assert.equal(a.campusCounts.BU,1);
 assert.equal(a.campusCounts.BC,0);
 assert.match(a.approvalDigest,/^[a-f0-9]{64}$/);
 assert.notEqual(a.approvalDigest,a.audienceDigest);
 assert.equal(review().approvalDigest,a.approvalDigest);
 assert.ok(!JSON.stringify({digest:a.approvalDigest,counts:a.campusCounts}).includes(applicant.email));
});
test("manual reference changes invalidate founder approval digest",()=>{
 const b=structuredClone(req);b.recipients[0].manualReference="Different manual clearance evidence";
 assert.notEqual(review(b).approvalDigest,review().approvalDigest);
});
test("exact recipient must match campus, page and HMAC; cannot inject outsider",()=>{
 const wrong=structuredClone(req);wrong.recipients[0].recipientHmac="f".repeat(64);
 assert.throws(()=>review(wrong),/campaign_candidate_changed_or_ineligible/);
 const other=structuredClone(req);other.recipients[0].campus="BC";
 assert.throws(()=>review(other),/campaign_candidate_changed_or_ineligible/);
});
test("withdrawn, previously booked, opted out, pending and exhausted candidates are blocked",()=>{
 assert.throws(()=>review(req,facts(),[{...applicant,workflowStatus:"Withdrawn / Not Proceeding"}]),/campaign_candidate_changed_or_ineligible/);
 assert.throws(()=>review(req,facts({reservedHmacs:new Set([hash(applicant.email)])})),/campaign_candidate_changed_or_ineligible/);
 assert.throws(()=>review(req,facts({suppressedHmacs:new Set([hash(applicant.email)])})),/campaign_candidate_changed_or_ineligible/);
 // No slot available is not an outreach eligibility blocker.
 assert.equal(review(req,facts({capacityByCampus:{BU:false,BC:false},remainingCapacityByCampus:{BU:0,BC:0}})).recipientCount,1);
 assert.throws(()=>review(req,facts({historyByHmac:new Map([[hash(applicant.email),[
   {state:"reconcile_required",sentAt:null,createdAt:"2026-10-29T18:00:00Z"}]]])})),/campaign_candidate_changed_or_ineligible/);
});
test("duplicates across campuses blocked and invalid scheduled dates rejected",()=>{
 const duplicate={...applicant,campus:"BC",pageId:"00000000000000000000000000000022"};
 assert.throws(()=>review(req,facts(),[applicant,duplicate]),/campaign_candidate_changed_or_ineligible/);
 assert.throws(()=>engine.validateCampaignRunKey("applicant_monday:2026-10-30",before),/campaign_run_key_invalid/);
 assert.throws(()=>engine.validateCampaignRunKey("applicant_friday:2026-10-23",before),/campaign_outside_approval_window/);
});
test("production manifest write is disabled unless independently approved",async()=>{
 process.env.VERCEL_ENV="preview";
 await assert.rejects(engine.commitProductionCampaign({...req,approvalDigest:review().approvalDigest}),
   /campaign_approval_disabled/);
 process.env.VERCEL_ENV="";
});
test("token encryption authenticates operation key and does not persist plaintext",()=>{
 const crypt=loadInterviewModule("interview-production-campaign-crypto");
 const old={VERCEL_ENV:process.env.VERCEL_ENV,INTERVIEW_DATA_ENV:process.env.INTERVIEW_DATA_ENV,
  INTERVIEW_TOKEN_ENCRYPTION_KEY:process.env.INTERVIEW_TOKEN_ENCRYPTION_KEY};
 try{
  process.env.VERCEL_ENV="production";process.env.INTERVIEW_DATA_ENV="production";
  process.env.INTERVIEW_TOKEN_ENCRYPTION_KEY=Buffer.alloc(32,17).toString("base64");
  const op="campaign-invite:applicant_friday:2026-10-30:11111111-1111-1111-1111-111111111111";
  const token="a".repeat(43),sealed=crypt.sealProductionCampaignToken(token,op);
  assert.equal(crypt.openProductionCampaignToken(sealed,op),token);
  assert.ok(!JSON.stringify(sealed).includes(token));
  assert.throws(()=>crypt.openProductionCampaignToken(sealed,op+"other"));
  process.env.VERCEL_ENV="preview";
  assert.throws(()=>crypt.sealProductionCampaignToken(token,op),/not_configured/);
 }finally{
  for(const [k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;
 }
});

test("cancellation can only target untouched approved manifests and never reopens queued sends",async()=>{
  const before={VERCEL_ENV:process.env.VERCEL_ENV,
    INTERVIEW_PRODUCTION_APPLICANT_APPROVAL_ENABLED:process.env.INTERVIEW_PRODUCTION_APPLICANT_APPROVAL_ENABLED};
  let called=0;
  const db={unsafe:async(sql,args)=>{
    called++;
    assert.match(sql,/state='approved'/);
    assert.match(sql,/r\.invitation_id IS NOT NULL/);
    assert.match(sql,/state='canceled'/);
    assert.deepEqual(args,["applicant_friday:2026-10-30"]);
    return [{id:"11111111-1111-1111-1111-111111111111"}];
  }};
  try{
    process.env.VERCEL_ENV="preview";
    process.env.INTERVIEW_PRODUCTION_APPLICANT_APPROVAL_ENABLED="true";
    await assert.rejects(engine.cancelProductionCampaign(req.runKey,{db}),/campaign_approval_disabled/);
    assert.equal(called,0);
    process.env.VERCEL_ENV="production";
    const result=await engine.cancelProductionCampaign(req.runKey,{db});
    assert.equal(result.canceled,true);
    assert.equal(result.canSend,false);
    assert.equal(called,1);
    await assert.rejects(engine.cancelProductionCampaign("random-run",{db}),/campaign_run_key_invalid/);
  }finally{
    for(const [k,v]of Object.entries(before)){
      if(v===undefined)delete process.env[k];else process.env[k]=v;
    }
  }
});


test("manual founder campaign keys are same-day, uniquely waved, and never impersonate a scheduled run",()=>{
  const manual={...req,runKey:"applicant_manual:2026-10-29:1"};
  const second={...manual,runKey:"applicant_manual:2026-10-29:2"};
  assert.equal(review(manual).recipientCount,1);
  assert.notEqual(review(manual).approvalDigest,review(second).approvalDigest);
  assert.throws(()=>engine.validateCampaignRunKey("applicant_manual:2026-10-30:1",before),/campaign_outside_approval_window/);
  assert.throws(()=>engine.validateCampaignRunKey("applicant_manual:2026-10-29:0",before),/campaign_run_key_invalid/);
  assert.throws(()=>engine.validateCampaignRunKey("applicant_manual:2026-10-29:1:extra",before),/campaign_run_key_invalid/);
  assert.throws(()=>engine.validateCampaignRunKey("applicant_manual:2026-10-28:1",before),/campaign_outside_approval_window/);
});

test("65 founder-reviewed interview invitations are permitted with zero open slots",()=>{
 const many=Array.from({length:65},(_,i)=>{
   const email="applicant"+i+"@example.edu";
   return {...applicant,email,pageId:(i+1).toString(16).padStart(32,"0")};
 });
 const request={runKey:"applicant_manual:2026-10-29:1",recipients:many.map(a=>({
   campus:a.campus,pageId:a.pageId,recipientHmac:hash(a.email),
   manualReference:"Founder reviewed prior Campus2Care outreach and invitation status",
 }))};
 const zeroCapacity=facts({capacityByCampus:{BU:false,BC:false},remainingCapacityByCampus:{BU:0,BC:0}});
 const result=review(request,zeroCapacity,many);
 assert.equal(result.recipientCount,65);
 assert.equal(result.campusCounts.BU,65);
 assert.throws(()=>review({...request,recipients:Array.from({length:101},(_,i)=>({
   campus:"BU",pageId:(i+1).toString(16).padStart(32,"0"),
   recipientHmac:hash("candidate"+i+"@example.edu"),
   manualReference:"Founder reviewed prior messages on 2026-10-29",
 }))},zeroCapacity,many),/campaign_recipient_count_invalid/);
});
