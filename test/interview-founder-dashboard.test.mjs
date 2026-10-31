import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {loadInterviewModule} from "./interview-test-loader.mjs";
const dash=loadInterviewModule("interview-founder-dashboard",{
  "./interview-production-audience-facts":{loadProductionAudienceFacts:async()=>{throw Error("unit");},productionAudienceReviewDatabase:()=>{throw Error("unit");}},
});
const approval=loadInterviewModule("interview-production-campaign-approval");
const key="dashboard-unit-test-secret-long-enough-for-hmac";
const hash=e=>createHmac("sha256",key).update("recipient:"+e).digest("hex");
const page=n=>String(n).padStart(32,"0");
const base={archived:false,interviewDatePresent:false,reservationIdPresent:false,stage:"Needs Interview",
  nextStep:"Schedule interview",interviewStatus:"Not Scheduled",workflowStatus:"Application Received"};
const people=[
  {...base,campus:"BU",pageId:page(1),email:"fresh@bu.edu",name:"Fresh"},
  {...base,campus:"BU",pageId:page(2),email:"invited@bu.edu",name:"Invited"},
  {...base,campus:"BC",pageId:page(3),email:"booked@bc.edu",name:"Booked"},
  {...base,campus:"BC",pageId:page(4),email:"done@bc.edu",name:"Done",interviewStatus:"Completed"},
  {...base,campus:"BC",pageId:page(5),email:"gone@bc.edu",name:"Gone",workflowStatus:"Withdrawn / Not Proceeding"},
];
const facts={reservedHmacs:new Set([hash("booked@bc.edu")]),completedHmacs:new Set(),suppressedHmacs:new Set(),
  optedOutHmacs:new Set(),manuallyClearedHmacs:new Set(),historyByHmac:new Map(),capacityByCampus:{BU:true,BC:true}};
const now=new Date("2026-11-01T15:00:00Z");

test("dashboard counts come from Notion statuses, Neon outreach and bookings",()=>{
  const {rows,mismatches}=dash.buildFounderDashboard({applicants:people,facts,authSecret:key,now,
    sent:new Map([[hash("invited@bu.edu"),{count:2,last:"2026-10-20T14:00:00.000Z"}]]),
    bookings:new Map([[hash("booked@bc.edu"),"active"]]),openSlots:{BU:4,BC:3}});
  const by=Object.fromEntries(rows.map(r=>[r.name,r]));
  assert.equal(by.Fresh.invitable,true);
  assert.equal(by.Invited.invitable,true,"earlier invitations do not disqualify");
  assert.equal(by.Invited.invitationsSent,2);
  assert.equal(by.Booked.invitable,false);
  assert.equal(by.Gone.invitable,false);
  assert.deepEqual(mismatches.map(m=>m.name),["Booked"],"booked in Neon but Notion still Not Scheduled");
  assert.deepEqual(dash.summarize(rows,"ALL",{BU:4,BC:3},{BU:4,BC:1}),
    {needingInterview:2,invitationsSent:2,scheduled:1,completed:1,awaitingResponse:1,openSlots:7,remainingCapacity:5});
  assert.equal(dash.summarize(rows,"BC",{BU:4,BC:3},{BU:4,BC:1}).needingInterview,0);
});
test("a batch larger than a campus's remaining slots is refused",()=>{
  const req={runKey:"applicant_sunday:2026-11-01",recipients:[1,2].map(n=>({campus:"BU",pageId:page(n),
    recipientHmac:hash(people[n-1].email),manualReference:"checked contact@ and legacy gmail"}))};
  const input={applicants:people,facts:{...facts,remainingCapacityByCampus:{BU:1,BC:5}},authSecret:key,now};
  assert.throws(()=>approval.campaignApprovalFromSnapshot(req,input),e=>e.code==="campaign_exceeds_bu_capacity");
  const ok=approval.campaignApprovalFromSnapshot(req,{...input,facts:{...input.facts,remainingCapacityByCampus:{BU:2,BC:0}}});
  assert.equal(ok.recipientCount,2);
});
