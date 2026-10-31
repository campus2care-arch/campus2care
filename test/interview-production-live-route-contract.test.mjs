import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {loadInterviewModule} from "./interview-test-loader.mjs";

function source(path){return readFileSync(new URL("../"+path,import.meta.url),"utf8");}
test("production applicant routes remain independent of staging endpoints",()=>{
 for(const action of ["status","slots","hold","cancel","reschedule","opt-out","verify"]){
  const route=source("app/api/interview/live/"+action+"/route.ts");
  assert.match(route,/handleLiveInterviewRequest/);
  assert.doesNotMatch(route,/interviewDatabase|requireInterviewStagingBooking|bob@campus2care\.org/);
 }
 const page=source("app/interview/page.tsx");
 assert.match(page,/productionRealEnabled\(\)/);
 assert.match(page,/InterviewBookingClient mode="production"/);
});
test("production release needs independent explicit applicant authorization",()=>{
 const launch=loadInterviewModule("interview-production-launch",{
  "./interview-production-canary":{
    productionCanaryConfig:()=>{throw Error("synthetic paths must remain isolated");},
    assertProductionCanaryIdentity:()=>{throw Error("synthetic identity rejected");},
  },
 });
 const base={VERCEL_ENV:"production",INTERVIEW_DATA_ENV:"production",
  INTERVIEW_LIVE_APPLICANTS_ENABLED:"true",INTERVIEW_LIVE_RELEASE_APPROVED:"true",
  INTERVIEW_PRODUCTION_ENABLED:"true",INTERVIEW_BOOKING_ENABLED:"true",
  INTERVIEW_PRODUCTION_WORKER_ADAPTER_READY:"true",
  INTERVIEW_CALENDAR_WRITES_ENABLED:"true",INTERVIEW_GMAIL_SENDS_ENABLED:"true",
  INTERVIEW_NOTION_WRITES_ENABLED:"true",INTERVIEW_OUTBOX_WORKER_ENABLED:"true",
  INTERVIEW_PRODUCTION_CANARY_ENABLED:"false"};
 assert.equal(launch.productionRealEnabled(base),true);
 for(const change of [{INTERVIEW_LIVE_APPLICANTS_ENABLED:"false"},
   {INTERVIEW_LIVE_RELEASE_APPROVED:"false"}, {INTERVIEW_PRODUCTION_CANARY_ENABLED:"true"},
   {INTERVIEW_NOTION_WRITES_ENABLED:"false"},{VERCEL_ENV:"preview"}]){
  assert.equal(launch.productionRealEnabled({...base,...change}),false);
 }
});
test("production webhook has a separate secret and no unauthenticated scheduled run",()=>{
 const route=source("app/api/interview/production-scheduler/route.ts");
 assert.match(route,/productionSchedulerAuthorized/);
 assert.match(route,/scheduler_not_authorized/);
 assert.match(route,/runProductionInterviewScheduler/);
 const workflow=source(".github/workflows/interview-production-scheduler.yml");
 assert.match(workflow,/refs\/heads\/main/);
 assert.match(workflow,/INTERVIEW_PRODUCTION_SCHEDULER_ENABLED/);
 assert.match(workflow,/secrets\.INTERVIEW_PRODUCTION_SCHEDULER_SECRET/);
});
