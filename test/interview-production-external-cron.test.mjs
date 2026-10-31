import test from "node:test";
import assert from "node:assert/strict";
import worker from "../infra/interview-cron/worker.mjs";
import {loadInterviewModule} from "./interview-test-loader.mjs";

const secret="synthetic-scheduler-secret-for-tests-0123456789";

test("Cloudflare hourly scheduler is inert until explicitly enabled",async()=>{
  let called=0;
  const original=globalThis.fetch;
  globalThis.fetch=async()=>{called++;throw Error("should not execute");};
  const ctx={waitUntil(){throw Error("should not schedule");}};
  try{
    await worker.scheduled({},{
      INTERVIEW_CRON_ENABLED:"false",
      SCHEDULER_SECRET:secret
    },ctx);
    assert.equal(called,0);
  }finally{globalThis.fetch=original;}
});

test("hourly scheduler posts only to fixed protected endpoint with bearer secret",async()=>{
  const original=globalThis.fetch;
  let call;
  globalThis.fetch=async(url,options)=>{
    call={url,options};
    return new Response("",{status:200});
  };
  let job;
  try{
    await worker.scheduled({},{
      INTERVIEW_CRON_ENABLED:"true",
      SCHEDULER_SECRET:secret
    },{waitUntil(promise){job=promise;}});
    await job;
    assert.equal(call.url,"https://www.campus2care.org/api/interview/production/scheduler");
    assert.equal(call.options.method,"POST");
    assert.equal(call.options.headers.Authorization,"Bearer "+secret);
    assert.equal(call.options.body,undefined);
  }finally{globalThis.fetch=original;}
});

test("scheduler rejects missing secrets and fails closed on HTTP errors",async()=>{
  await assert.rejects(worker.scheduled({},{
    INTERVIEW_CRON_ENABLED:"true",SCHEDULER_SECRET:"short"
  },{waitUntil(){}}),/not_configured/);
  const original=globalThis.fetch;
  let pending;
  globalThis.fetch=async()=>new Response("",{status:503});
  try{
    await worker.scheduled({},{
      INTERVIEW_CRON_ENABLED:"true",SCHEDULER_SECRET:secret
    },{waitUntil(p){pending=p;}});
    await assert.rejects(pending,/scheduler_http_503/);
  }finally{globalThis.fetch=original;}
});

test("HTML invitation has safe clickable Campus2Care booking action",()=>{
  const {renderInterviewMessage}=loadInterviewModule("interview-email");
  const msg=renderInterviewMessage({
    operationKey:"campaign-invite:applicant_friday:2026-10-30:11111111-1111-1111-1111-111111111111",
    kind:"invitation",campus:"BU",recipient:"synthetic@example.invalid",
    link:"https://www.campus2care.org/interview#token=only-a-test",
  });
  assert.match(msg.html,/Schedule my interview/);
  assert.match(msg.html,/href="https:\/\/www\.campus2care\.org\/interview#token=only-a-test"/);
  assert.match(msg.text,/https:\/\/www\.campus2care\.org\/interview#token=only-a-test/);
  assert.throws(()=>renderInterviewMessage({
    operationKey:"campaign-invite:applicant_friday:2026-10-30:11111111-1111-1111-1111-111111111111",
    kind:"invitation",recipient:"synthetic@example.invalid",
    link:"https://unrelated-site.invalid/interview#token=fake",
  }),/invalid_message_link/);
});
