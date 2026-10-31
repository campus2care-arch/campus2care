import test from "node:test";
import assert from "node:assert/strict";
import { loadInterviewModule } from "./interview-test-loader.mjs";

const bu="03192649741442fe86acdddcc7320798";
const bc="bc8eaec9a5d449cd87426e8613299a93";
const notionId="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const email="test@campus2care.org";
const service=loadInterviewModule("interview-production-notion",{
  "./interview-production-canary": {
    assertProductionCanaryIdentity:(campus,recipient,pageId)=>{
      if(recipient!==email || pageId.replaceAll("-","")!==notionId)throw Error("canary_denied");
      return {campus,email:recipient,pageId:notionId};
    },
  },
});
function page(campus="BU"){
  return {
    id:notionId,archived:false,in_trash:false,
    parent:{type:"database_id",database_id:campus==="BU"?bu:bc},
    properties:{
      Email:{type:"email",email},
      Stage:{type:"select",select:{name:"Needs Interview"}},
      "Next Step":{type:"select",select:{name:"Schedule interview"}},
      "Interview Status":{type:"select",select:{name:"Not Scheduled"}},
      "Workflow Status":{type:"select",select:{name:"Application Received"}},
      "Scheduling Reservation ID":{type:"rich_text",rich_text:[]},
      "Interview Date":{type:"date",date:null},
    },
  };
}
const input={campus:"BU",pageId:notionId,email};
const fetchPage=(value)=>async(url,opts)=>{
  assert.equal(url,"https://api.notion.com/v1/pages/"+notionId);
  assert.equal(opts.method,undefined);
  assert.equal(opts.cache,"no-store");
  assert.equal(opts.headers["Notion-Version"],"2022-06-28");
  return Response.json(value);
};
test("approved BU canary is live-readable only when Notion identity and stage match",async()=>{
  const result=await service.verifyLiveCanaryApplicant(input,{token:"a".repeat(30),transport:fetchPage(page())});
  assert.deepEqual(result,{campus:"BU",notionPageId:notionId,recipientEmail:email});
});
test("canary read refuses swapped campuses or Notion email identity",async()=>{
  await assert.rejects(service.verifyLiveCanaryApplicant(input,{token:"a".repeat(30),transport:fetchPage(page("BC"))}),/campus_mismatch/);
  const changed=page();changed.properties.Email.email="someone@example.org";
  await assert.rejects(service.verifyLiveCanaryApplicant(input,{token:"a".repeat(30),transport:fetchPage(changed)}),/email_mismatch/);
});
test("withdrawn, scheduled, and already-booked applicant records cannot proceed",async()=>{
  const withdrawn=page();withdrawn.properties["Workflow Status"].select.name="Paused";
  await assert.rejects(service.verifyLiveCanaryApplicant(input,{token:"a".repeat(30),transport:fetchPage(withdrawn)}),/applicant_inactive/);
  const scheduled=page();scheduled.properties["Interview Status"].select.name="Scheduled";
  await assert.rejects(service.verifyLiveCanaryApplicant(input,{token:"a".repeat(30),transport:fetchPage(scheduled)}),/interview_already_processed/);
  const reserved=page();reserved.properties["Scheduling Reservation ID"].rich_text=[{plain_text:"exists"}];
  await assert.rejects(service.verifyLiveCanaryApplicant(input,{token:"a".repeat(30),transport:fetchPage(reserved)}),/existing_reservation/);
  const dated=page();dated.properties["Interview Date"].date={start:"2026-11-02"};
  await assert.rejects(service.verifyLiveCanaryApplicant(input,{token:"a".repeat(30),transport:fetchPage(dated)}),/existing_date/);
});
test("archived page, token, rate limit and connectivity failures fail closed",async()=>{
  const archived=page();archived.archived=true;
  await assert.rejects(service.verifyLiveCanaryApplicant(input,{token:"a".repeat(30),transport:fetchPage(archived)}),/identity_invalid/);
  await assert.rejects(service.verifyLiveCanaryApplicant(input,{token:"short",transport:fetchPage(page())}),/not_configured/);
  await assert.rejects(service.verifyLiveCanaryApplicant(input,{token:"a".repeat(30),transport:async()=>new Response(null,{status:429})}),/rate_limited/);
  await assert.rejects(service.verifyLiveCanaryApplicant(input,{token:"a".repeat(30),transport:async()=>{throw Error("offline");}}),/unreachable/);
});

test("rescheduling reads require the exact existing booking and active scheduled workflow",async()=>{
 const reservationId="11111111-1111-1111-1111-111111111111";
 const scheduled=page();scheduled.properties["Interview Status"].select.name="Scheduled";
 scheduled.properties["Workflow Status"].select.name="Interview Scheduled";
 scheduled.properties["Scheduling Reservation ID"].rich_text=[{plain_text:reservationId}];
 await service.verifyLiveCanaryApplicant({...input,reservationId},{token:"a".repeat(30),transport:fetchPage(scheduled)});
 await assert.rejects(service.verifyLiveCanaryApplicant({...input,reservationId:"22222222-2222-2222-2222-222222222222"},{token:"a".repeat(30),transport:fetchPage(scheduled)}),/booking_changed/);
 scheduled.properties["Workflow Status"].select.name="Paused";
 await assert.rejects(service.verifyLiveCanaryApplicant({...input,reservationId},{token:"a".repeat(30),transport:fetchPage(scheduled)}),/booking_changed/);
});
