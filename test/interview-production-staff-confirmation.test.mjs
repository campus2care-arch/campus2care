import test from "node:test";
import assert from "node:assert/strict";
import {loadInterviewModule} from "./interview-test-loader.mjs";

const id="11111111-1111-1111-1111-111111111111";
const staffId="22222222-2222-2222-2222-222222222222";
const input={
  operationKey:"interview-staff-confirmation:"+id+":"+staffId,
  reservationId:id,interviewerId:staffId,email:"cori@campus2care.org",
  campus:"BU",startsAt:"2026-11-02T19:00:00.000Z",
  applicantFirstName:"Jordan Lee",role:"lead",
};
let tokenImpl=async()=>"x".repeat(30);
const sender=loadInterviewModule("interview-production-staff-confirmation",{
  "./interview-production-launch":{productionRealEnabled:()=>false,productionRealConfig:()=>{throw Error("real");}},
  "./interview-production-canary":{productionCanaryConfig:()=>({})},
  "./interview-production-providers":{
    productionGoogleAccessToken:(...args)=>tokenImpl(...args),
    ProductionProviderError:class ProductionProviderError extends Error{},
  },
});

function gmailTransport(response){
  const calls=[];
  const transport=async(url,init)=>{
    calls.push({url,init});
    if(typeof response==="function")return response(url,init);
    return response;
  };
  return {calls,transport};
}
function mimeOf(init){
  const raw=JSON.parse(init.body).raw;
  const mime=Buffer.from(raw,"base64url").toString();
  const parts=[...mime.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([^\r]+)/g)]
    .map(match=>Buffer.from(match[1],"base64").toString());
  return {mime,body:parts.join("\n")};
}

test("staff booking confirmation stays off until the founder flag is set",async()=>{
  const previous=process.env.INTERVIEW_REAL_STAFF_CONFIRMATIONS_APPROVED;
  delete process.env.INTERVIEW_REAL_STAFF_CONFIRMATIONS_APPROVED;
  let calls=0;
  try{
    await assert.rejects(sender.sendProductionStaffBookingConfirmation(input,async()=>{
      calls++;throw Error("network");
    }),error=>error.message==="staff_confirmation_not_approved" && error.disposition==="fail");
    assert.equal(calls,0);
  }finally{
    if(previous===undefined)delete process.env.INTERVIEW_REAL_STAFF_CONFIRMATIONS_APPROVED;
    else process.env.INTERVIEW_REAL_STAFF_CONFIRMATIONS_APPROVED=previous;
  }
});

test("staff booking confirmation classifies pre-send OAuth separately from ambiguous Gmail acceptance",async()=>{
  const previous=process.env.INTERVIEW_REAL_STAFF_CONFIRMATIONS_APPROVED;
  process.env.INTERVIEW_REAL_STAFF_CONFIRMATIONS_APPROVED="true";
  const logs=[];
  const original=console.info;
  console.info=(...args)=>logs.push(args.map(String).join(" "));
  try{
    tokenImpl=async()=>{throw Error("google_provider_invalid_grant");};
    await assert.rejects(sender.sendProductionStaffBookingConfirmation(input,async()=>{
      throw Error("token failure must not reach Gmail");
    }),error=>{
      assert.equal(error.disposition,"fail");
      assert.equal(error.errorClass,"oauth_refresh");
      assert.equal(error.message,"staff_confirmation_gmail_oauth_invalid_grant");
      return true;
    });
    tokenImpl=async()=>"x".repeat(30);
    const rejected=gmailTransport(new Response(null,{status:400}));
    await assert.rejects(sender.sendProductionStaffBookingConfirmation(input,rejected.transport),error=>{
      assert.equal(error.disposition,"fail");
      assert.equal(error.errorClass,"gmail_rejected");
      assert.equal(error.httpStatus,400);
      assert.equal(error.message,"staff_confirmation_gmail_rejected");
      return true;
    });
    const upstream=gmailTransport(new Response(null,{status:503}));
    await assert.rejects(sender.sendProductionStaffBookingConfirmation(input,upstream.transport),error=>{
      assert.equal(error.disposition,"uncertain");
      assert.equal(error.errorClass,"upstream");
      assert.equal(error.httpStatus,503);
      return true;
    });
    await assert.rejects(sender.sendProductionStaffBookingConfirmation(input,async()=>{
      const error=new Error("aborted");
      error.name="TimeoutError";
      throw error;
    }),error=>error.disposition==="uncertain" && error.errorClass==="timeout");
    assert.equal(logs.length,0);
  }finally{
    console.info=original;
    tokenImpl=async()=>"x".repeat(30);
    if(previous===undefined)delete process.env.INTERVIEW_REAL_STAFF_CONFIRMATIONS_APPROVED;
    else process.env.INTERVIEW_REAL_STAFF_CONFIRMATIONS_APPROVED=previous;
  }
});

test("staff booking confirmation is branded contact@ mail without the Meet URL or invite token",async()=>{
  const previous=process.env.INTERVIEW_REAL_STAFF_CONFIRMATIONS_APPROVED;
  process.env.INTERVIEW_REAL_STAFF_CONFIRMATIONS_APPROVED="true";
  tokenImpl=async()=>"x".repeat(30);
  try{
    const sent=gmailTransport(async(_url,init)=>{
      const decoded=mimeOf(init);
      assert.match(decoded.mime,/From: Campus2Care <contact@campus2care\.org>/);
      assert.match(decoded.mime,/To: cori@campus2care\.org/);
      assert.match(decoded.body,/Applicant: Jordan/);
      assert.match(decoded.body,/Campus: BU/);
      assert.match(decoded.body,/2:00 PM Eastern Time/);
      assert.match(decoded.body,/Google Calendar invitation/);
      assert.match(decoded.body,/border-top:5px solid #b3131b/);
      assert.doesNotMatch(decoded.body,/meet\.google\.com/);
      assert.doesNotMatch(decoded.body,/token=/);
      assert.doesNotMatch(decoded.mime,/meet\.google\.com/);
      return Response.json({id:"staff-gmail-1"});
    });
    assert.equal(await sender.sendProductionStaffBookingConfirmation(input,sent.transport),"staff-gmail-1");
    assert.equal(sent.calls.length,1);
    await assert.rejects(sender.sendProductionStaffBookingConfirmation({
      ...input,email:"student@gmail.com",
    },async()=>{throw Error("must not send");}),/staff_confirmation_delivery_invalid/);
  }finally{
    if(previous===undefined)delete process.env.INTERVIEW_REAL_STAFF_CONFIRMATIONS_APPROVED;
    else process.env.INTERVIEW_REAL_STAFF_CONFIRMATIONS_APPROVED=previous;
  }
});
