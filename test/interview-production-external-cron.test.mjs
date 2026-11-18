import test from "node:test";
import assert from "node:assert/strict";
import worker, { callScheduler } from "../infra/interview-cron/worker.mjs";
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

test("non-2xx scheduler responses log status and a safe reason",async()=>{
  const original=globalThis.fetch,errors=[];
  const prior=console.error;
  console.error=(line)=>errors.push(String(line));
  globalThis.fetch=async()=>Response.json({
    ok:false,error:"production_scheduler_unavailable",detail:"secret-value-must-not-log",
  },{status:503});
  let pending;
  try{
    await worker.scheduled({cron:"0 * * * *"},{
      INTERVIEW_CRON_ENABLED:"true",SCHEDULER_SECRET:secret
    },{waitUntil(p){pending=p;}});
    await assert.rejects(pending,/scheduler_http_503/);
    const event=JSON.parse(errors.at(-1));
    assert.equal(event.c2c,"scheduler_http_error");
    assert.equal(event.status,503);
    assert.equal(event.reason,"production_scheduler_unavailable");
    assert.equal(JSON.stringify(event).includes("secret-value"),false);
  }finally{
    globalThis.fetch=original;
    console.error=prior;
  }
});

test("a hung scheduler request is logged as a timeout",async()=>{
  const errors=[];
  const prior=console.error;
  console.error=(line)=>errors.push(String(line));
  const hanging=(_url,options)=>new Promise((_resolve,reject)=>{
    options.signal.addEventListener("abort",()=>reject(options.signal.reason));
  });
  try{
    await assert.rejects(callScheduler(secret,"0 * * * *",hanging,20),/scheduler_timeout/);
    const event=JSON.parse(errors.at(-1));
    assert.equal(event.c2c,"scheduler_call_failed");
    assert.equal(event.kind,"timeout");
    assert.equal(event.reason,"timed_out");
  }finally{console.error=prior;}
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
