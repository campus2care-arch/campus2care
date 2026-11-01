import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {loadInterviewModule} from "./interview-test-loader.mjs";

const mod=loadInterviewModule("interview-production-applicant-review");
const secret="review-test-only-secret-strong-enough-0123456789";
const hmac=(email)=>createHmac("sha256",secret)
  .update("recipient:"+email.toLowerCase()).digest("hex");
const uid=(n)=>n.toString(16).padStart(32,"0");
const BU="03192649741442fe86acdddcc7320798";
const BC="bc8eaec9a5d449cd87426e8613299a93";
const env={VERCEL_ENV:"production",INTERVIEW_DATA_ENV:"production",
  INTERVIEW_PRODUCTION_APPLICANT_REVIEW_ENABLED:"true",
  INTERVIEW_NOTION_LIVE_TOKEN:"test-token-not-used-for-real-access-1234"};
function page(campus,id,email,overrides={}){
  return {id,parent:{type:"database_id",database_id:campus==="BU"?BU:BC},
    properties:{Email:{type:"email",email},Stage:{type:"select",select:{name:"Needs Interview"}},
      "Next Step":{type:"select",select:{name:"Schedule interview"}},
      "Workflow Status":{type:"select",select:{name:"Application Received"}},
      "Interview Status":{type:"select",select:{name:"Not Scheduled"}},
      "Interview Date":{type:"date",date:null},
      "Scheduling Reservation ID":{type:"rich_text",rich_text:[]}},...overrides};
}
const sample=(campus,pageId,email,extra={})=>({
  campus,pageId,email,stage:"Needs Interview",nextStep:"Schedule interview",
  workflowStatus:"Application Received",interviewStatus:"Not Scheduled",
  interviewDatePresent:false,reservationIdPresent:false,archived:false,...extra});
const facts=(options={})=>({
  reservedHmacs:new Set(),completedHmacs:new Set(),suppressedHmacs:new Set(),
  optedOutHmacs:new Set(),manuallyClearedHmacs:new Set(),
  historyByHmac:new Map(),capacityByCampus:{BU:true,BC:true},...options});

test("preview and unapproved production cannot read live applicants",async()=>{
  let calls=0; const transport=async()=>{calls++;throw Error("network forbidden");};
  await assert.rejects(
    mod.scanProductionApplicantPipelines(transport,{...env,VERCEL_ENV:"preview"}),
    /audience_review_disabled/);
  await assert.rejects(
    mod.scanProductionApplicantPipelines(transport,{...env,INTERVIEW_PRODUCTION_APPLICANT_REVIEW_ENABLED:"false"}),
    /audience_review_disabled/);
  assert.equal(calls,0);
});

test("BU and BC source identities are checked, pagination is bounded, and scanner has no writes",async()=>{
  const seen=[];
  const transport=async(url,init)=>{
    seen.push({url,init});
    assert.equal(init.method,"POST");
    assert.match(url,/\/databases\/[0-9a-f]{32}\/query$/);
    const campus=url.includes(BU)?"BU":"BC";
    if(campus==="BU"&&!JSON.parse(init.body).start_cursor)
      return Response.json({results:[page("BU",uid(1),"person@school.edu")],has_more:true,next_cursor:"second"});
    if(campus==="BU")
      return Response.json({results:[page("BU",uid(2),"second@school.edu")],has_more:false});
    return Response.json({results:[page("BC",uid(3),"college@school.edu")],has_more:false});
  };
  const result=await mod.scanProductionApplicantPipelines(transport,env);
  assert.equal(result.length,3);
  assert.deepEqual(result.map(x=>x.campus),["BU","BU","BC"]);
  assert.ok(seen.every(x=>x.init.method==="POST" && !/\/pages\//.test(x.url)));
  assert.equal(result[0].interviewDatePresent,false);
  assert.equal(result[0].reservationIdPresent,false);
});

test("wrong-campus parent, rate limit, and broken cursor fail closed",async()=>{
  const wrong=async()=>Response.json({results:[page("BC",uid(4),"x@school.edu")],has_more:false});
  await assert.rejects(mod.scanProductionApplicantPipelines(wrong,env),/audience_wrong_campus_parent/);
  const throttle=async()=>new Response("",{status:429});
  await assert.rejects(mod.scanProductionApplicantPipelines(throttle,env),/audience_notion_rate_limited/);
  const loop=async()=>Response.json({results:[],has_more:true,next_cursor:"repeat"});
  await assert.rejects(mod.scanProductionApplicantPipelines(loop,env),/audience_invalid_cursor/);
});

test("duplicate email across campus is blocked for both records",()=>{
  const applicants=[sample("BU",uid(11),"same@school.edu"),sample("BC",uid(12),"same@school.edu")];
  const result=mod.reviewProductionApplicantAudience({applicants,facts:facts({
    manuallyClearedHmacs:new Set([hmac("same@school.edu")])}),authSecret:secret,now:new Date("2026-10-30T14:00:00Z")});
  assert.equal(result.readyForFounderReview,0);
  assert.equal(result.countsByDecision.duplicate_across_pipelines,2);
  assert.ok(!JSON.stringify(result).includes("same@school.edu"));
});

test("strict gating blocks prior booking and opt-out, while lack of slots does not block invitations",()=>{
  const applicants=[
    sample("BU",uid(21),"prior@school.edu"),
    sample("BU",uid(22),"optout@school.edu"),
    sample("BC",uid(23),"incomplete@school.edu",{interviewDatePresent:true}),
    sample("BC",uid(24),"manual@school.edu"),
    sample("BU",uid(25),"no-capacity@school.edu"),
  ];
  const result=mod.reviewProductionApplicantAudience({applicants,
    facts:facts({reservedHmacs:new Set([hmac("prior@school.edu")]),
      optedOutHmacs:new Set([hmac("optout@school.edu")]),
      capacityByCampus:{BU:false,BC:true},
      manuallyClearedHmacs:new Set([hmac("no-capacity@school.edu")])}),
    authSecret:secret,now:new Date("2026-10-30T14:00:00Z")});
  assert.deepEqual(result.countsByDecision,{
    prior_booking_or_interview:1,suppressed_or_opted_out:1,
    interview_already_processed:1,manual_outreach_not_reconciled:1,eligible_for_founder_review:1});
  assert.equal(result.readyForFounderReview,1);
});

test("recipient-wide history enforces spacing and unresolved sends across BU/BC",()=>{
  const now=new Date("2026-10-30T14:00:00Z");
  const applicants=[
    sample("BU",uid(31),"recent@school.edu"),
    sample("BC",uid(32),"queued@school.edu"),
    sample("BU",uid(33),"cleared@school.edu"),
  ];
  const cleared=new Set(applicants.map(a=>hmac(a.email)));
  const history=new Map([
    [hmac("recent@school.edu"),[{state:"sent",sentAt:"2026-10-29T14:00:00Z",createdAt:"2026-10-29T14:00:00Z"}]],
    [hmac("queued@school.edu"),[{state:"reconcile_required",sentAt:null,createdAt:"2026-10-29T14:00:00Z"}]],
  ]);
  const result=mod.reviewProductionApplicantAudience({applicants,
    facts:facts({manuallyClearedHmacs:cleared,historyByHmac:history}),
    authSecret:secret,now});
  assert.equal(result.countsByDecision.spacing_48_hours,1);
  assert.equal(result.countsByDecision.unresolved_prior_message,1);
  assert.equal(result.readyForFounderReview,1);
  assert.equal(result.manifestSha256.length,64);
  assert.equal(result.entries.find(x=>x.decision==="eligible_for_founder_review").recipientHmac,hmac("cleared@school.edu"));
});

test("manifest order is stable and no applicant email appears in result",()=>{
  const applicants=[sample("BC",uid(41),"b@school.edu"),sample("BU",uid(42),"a@school.edu")];
  const conditions=facts({manuallyClearedHmacs:new Set(applicants.map(a=>hmac(a.email)))});
  const review=(rows)=>mod.reviewProductionApplicantAudience({
    applicants:rows,facts:conditions,authSecret:secret,now:new Date("2026-10-30T14:00:00Z")});
  const x=review(applicants),y=review([...applicants].reverse());
  assert.deepEqual(x,y);
  assert.ok(!JSON.stringify(x).includes("@school.edu"));
});
