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
   payload:JSON.stringify({kind:"invitation",campus:"BU",
     token:{ciphertext:"mock",iv:"mock",tag:"mock"}})};
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
 assert.ok(record.some(x=>x.query.includes("campaign_token_reconciliation_required")));
 const second=await worker.processProductionCampaignOutbox(sql,2,{
   verify:async()=>true,deliver:async()=>{throw Error("unexpected resend");}
 });
 assert.equal(second.claimed,0);
});

function campaignInput(){
  return {
    operationKey:"campaign-invite:applicant_manual:2026-11-13:1:11111111-1111-1111-1111-111111111111",
    campus:"BU",pageId:"a".repeat(32),email:"nobody@example.edu",token:"a".repeat(43),
  };
}
test("token and definite Gmail responses are not outcome-uncertain",async()=>{
  process.env.INTERVIEW_BASE_URL="https://www.campus2care.org";
  class ProductionProviderError extends Error{
    constructor(code,disposition,httpStatus=null){
      super(code);this.name="ProductionProviderError";this.code=code;this.disposition=disposition;this.httpStatus=httpStatus;
    }
  }
  const providers={ProductionProviderError,productionGoogleAccessToken:async()=>{
    throw new ProductionProviderError("production_google_oauth_unavailable","retry",400);
  }};
  const mod=loadInterviewModule("interview-production-campaign-mail",{
    "./interview-production-campaign-queue":{applicantCampaignSendingAuthorized:()=>{}},
    "./interview-production-launch":{productionRealConfig:()=>({})},
    "./interview-production-providers":providers,
    "./interview-campaign-gmail-disposition":loadInterviewModule("interview-campaign-gmail-disposition",{
      "./interview-production-providers":providers,
    }),
  });
  let called=false;
  await assert.rejects(mod.sendProductionCampaignInvitation(campaignInput(),async()=>{called=true;throw Error("send forbidden");}),error=>{
    assert.equal(error.disposition,"fail");
    assert.equal(error.httpStatus,400);
    assert.equal(error.message,"campaign_gmail_oauth_invalid_grant");
    return true;
  });
  assert.equal(called,false);
  const gmail=loadInterviewModule("interview-production-campaign-mail",{
    "./interview-production-campaign-queue":{applicantCampaignSendingAuthorized:()=>{}},
    "./interview-production-launch":{productionRealConfig:()=>({})},
    "./interview-production-providers":{productionGoogleAccessToken:async()=>"x".repeat(30),ProductionProviderError},
  });
  for(const [status,disposition,code] of [[401,"fail","campaign_gmail_unauthorized"],[403,"fail","campaign_gmail_forbidden"],[500,"uncertain","campaign_gmail_outcome_uncertain"],[200,"uncertain","campaign_gmail_outcome_uncertain"]]){
    await assert.rejects(gmail.sendProductionCampaignInvitation(campaignInput(),async(url)=>{
      assert.match(String(url),/messages\/send$/);
      if(status===200)return Response.json({id:status===200&&code.endsWith("uncertain")?"":"abcde"});
      return new Response("no",{status});
    }),error=>{
      assert.equal(error.disposition,disposition);
      assert.equal(error.message,code);
      if(status!==200)assert.equal(error.httpStatus,status);
      return true;
    });
  }
  await assert.rejects(gmail.sendProductionCampaignInvitation(campaignInput(),async()=>{
    const error=new Error("The operation was aborted");error.name="TimeoutError";throw error;
  }),error=>{
    assert.equal(error.disposition,"uncertain");
    assert.equal(error.errorClass,"timeout");
    return true;
  });
});

test("a pre-send OAuth failure is stored and retried without a reconcile hold",async()=>{
  const token="n".repeat(43),op="campaign-invite:applicant_manual:2026-11-13:1:11111111-1111-1111-1111-111111111111";
  const job={id:"22222222-2222-2222-2222-222222222222",operation_key:op,attempts:1,
    message_id:"33333333-3333-3333-3333-333333333333",
    invitation_id:"11111111-1111-1111-1111-111111111111",
    campus:"BU",page_id:"4".repeat(32),recipient_hmac:"5".repeat(64),
    email:"person@example.edu",manifest_id:"66666666-6666-6666-6666-666666666666",
    expires_at:new Date("2099-01-01T00:00:00Z"),
    payload:JSON.stringify({kind:"invitation",campus:"BU",token:{ciphertext:"mock",iv:"mock",tag:"mock"}})};
  const worker=loadInterviewModule("interview-production-campaign-mail",{
    "./interview-production-campaign-queue":{applicantCampaignSendingAuthorized:()=>{}},
    "./interview-production-campaign-crypto":{openProductionCampaignToken:()=>token},
    "./interview-production-notion":{verifyLiveCanaryApplicant:async()=>true},
  });
  const record=[];
  let claimed=false;
  const sql=async(query,args=[])=>{
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
  const error=new Error("google_provider_invalid_grant");
  error.httpStatus=400;
  const result=await worker.processProductionCampaignOutbox(sql,2,{
    verify:async()=>true,
    deliver:async()=>{throw error;},
  });
  assert.equal(result.claimed,1);
  assert.equal(result.sent,0);
  assert.equal(result.reconciliation,0);
  assert.equal(result.statuses[0].disposition,"failed");
  assert.equal(result.statuses[0].httpStatus,400);
  assert.equal(result.statuses[0].errorClass,"oauth_refresh");
  const stored=record.filter(entry=>(entry.args??[]).includes("campaign_gmail_oauth_invalid_grant"));
  assert.ok(stored.some(entry=>entry.query.includes("state='failed'")));
  assert.equal(stored.some(entry=>entry.query.includes("reconcile_required")),false);
  assert.match(JSON.stringify(stored),/oauth_refresh/);
  assert.doesNotMatch(JSON.stringify(result),/person@example\.edu/);
});

test("send routes log counts and statuses without recipient addresses",async()=>{
  const logs=[];
  const manifest={state:"running",expires_at:new Date("2099-01-01T00:00:00Z"),approved_by:"president@campus2care.org"};
  const db={unsafe:async sql=>{
    if(sql.includes("FROM interview.applicant_campaign_manifest WHERE"))return [manifest];
    if(sql.includes("GROUP BY"))return [{state:"queued",count:1}];
    return [];
  }};
  const processed={claimed:1,sent:0,suppressed:0,reconciliation:0,statuses:[
    {code:"campaign_gmail_unauthorized",errorClass:"gmail_unauthorized",httpStatus:401,disposition:"failed"}]};
  const auth={
    staffFromRequest:()=>({role:"admin",email:"president@campus2care.org"}),
    interviewBaseOrigin:()=>"https://www.campus2care.org",
  };
  const jsonResponse={NextResponse:{json:(body,options)=>({body,status:options?.status??200,headers:options?.headers})}};
  const original=process.env.VERCEL_ENV;
  process.env.VERCEL_ENV="production";
  const request={
    headers:{get:name=>name==="origin"?"https://www.campus2care.org":"application/json"},
    json:async()=>({runKey:"applicant_manual:2026-11-13:1",emails:["person@example.edu"],confirmedNotSent:true}),
  };
  try{
    const sendNow=loadInterviewModule("../app/api/interview/admin/production-applicant-send-now/route",{
      "next/server":jsonResponse,
      "../../../../../lib/interview-auth":auth,
      "../../../../../lib/interview-production-db":{productionInterviewDatabase:()=>db},
      "../../../../../lib/interview-production-campaign-queue":{
        applicantCampaignSendingAuthorized:()=>{},
        queueApprovedApplicantCampaign:async()=>({queued:0,skipped:0,blocked:[]}),
      },
      "../../../../../lib/interview-production-campaign-mail":{
        processProductionCampaignOutbox:async()=>processed,
        campaignSendLog:(route,runKey,result)=>logs.push({route,runKey,result}),
      },
    });
    const sent=await sendNow.POST(request);
    assert.equal(sent.status,200);
    assert.equal(logs[0].route,"send-now");
    assert.equal(logs[0].runKey,"applicant_manual:2026-11-13:1");
    assert.equal(logs[0].result.claimed,1);
    assert.equal(logs[0].result.sent,0);
    assert.equal(logs[0].result.reconciliation,0);
    assert.equal(logs[0].result.statuses[0].httpStatus,401);
    assert.doesNotMatch(JSON.stringify(logs[0]),/@/);
    const sendHeld=loadInterviewModule("../app/api/interview/admin/production-applicant-send-held/route",{
      "next/server":jsonResponse,
      "../../../../../lib/interview-auth":auth,
      "../../../../../lib/interview-production-db":{productionInterviewDatabase:()=>db},
      "../../../../../lib/interview-production-campaign-queue":{applicantCampaignSendingAuthorized:()=>{}},
      "../../../../../lib/interview-production-campaign-mail":{
        processProductionCampaignOutbox:async()=>processed,
        campaignSendLog:(route,runKey,result)=>logs.push({route,runKey,result}),
      },
    });
    db.begin=async()=>{throw Error("held_invitation_not_retryable");};
    const held=await sendHeld.POST(request);
    assert.equal(held.status,409);
    assert.equal(logs.at(-1).route,"send-held");
    assert.equal(logs.at(-1).runKey,"applicant_manual:2026-11-13:1");
    assert.equal(logs.at(-1).result.statuses[0].code,"held_invitation_not_retryable");
    assert.doesNotMatch(JSON.stringify(logs.at(-1)),/person@example\.edu/);
  }finally{
    if(original===undefined)delete process.env.VERCEL_ENV;else process.env.VERCEL_ENV=original;
  }
});
