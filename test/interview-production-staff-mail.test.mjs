import test from "node:test";
import assert from "node:assert/strict";
import {loadInterviewModule} from "./interview-test-loader.mjs";

function fixture(kind="ea_request"){
  process.env.INTERVIEW_REAL_STAFF_EMAILS_APPROVED="true";
  const seen=new Set(),queued=[];
  const tx=async(parts,...args)=>{
    const text=parts.join("?");
    if(text.includes("INSERT INTO interview.dispatch_run")){
      if(seen.has(args[0]))return [];
      seen.add(args[0]);return [{id:"11111111-1111-1111-1111-111111111111"}];
    }
    if(text.includes("FROM interview.interviewer i"))return [
      {id:"22222222-2222-2222-2222-222222222222",workspace_email:"cori@campus2care.org",status:null},
      {id:"33333333-3333-3333-3333-333333333333",workspace_email:"sophia@campus2care.org",status:"confirmed"},
      {id:"44444444-4444-4444-4444-444444444444",workspace_email:"president@campus2care.org",status:"confirmed"},
    ];
    if(text.includes("INSERT INTO interview.message")){
      queued.push({key:args[0],email:args[1],kind:args[2]});
      return [{id:"55555555-5555-5555-5555-555555555555"}];
    }
    if(text.includes("INSERT INTO interview.integration_outbox")||
       text.includes("UPDATE interview.dispatch_run"))return [];
    throw Error("unexpected SQL "+text.slice(0,90));
  };
  tx.begin=fn=>fn(tx);
  tx.json=x=>x;
  const service=loadInterviewModule("interview-production-staff-mail",{
    "./interview-production-launch":{productionRealConfig:()=>({})},
    "./interview-dispatch-policy":{dueInterviewDispatches:()=>[
      {kind,runKey:kind+":2026-10-29",weekStart:"2026-11-02"}]},
    "./interview-production-providers":{productionGoogleAccessToken:async()=>{throw Error("unexpected token request");}},
  });
  return {service,tx,seen,queued};
}
test("production staff notifications need separately approved flag",async()=>{
  const f=fixture();
  process.env.INTERVIEW_REAL_STAFF_EMAILS_APPROVED="false";
  await assert.rejects(f.service.queueDueProductionStaffEmails(f.tx),/not_approved/);
  assert.equal(f.queued.length,0);
});
test("Wednesday requests reach all active EA roster entries exactly once per key",async()=>{
  const f=fixture("ea_request");
  assert.equal(await f.service.queueDueProductionStaffEmails(f.tx),3);
  assert.equal(await f.service.queueDueProductionStaffEmails(f.tx),0);
  assert.equal(f.queued.length,3);
  assert.deepEqual(f.queued.map(x=>x.kind),["ea_request","ea_request","ea_request"]);
});
test("Thursday reminder skips staff with confirmed weekly availability",async()=>{
  const f=fixture("ea_reminder");
  assert.equal(await f.service.queueDueProductionStaffEmails(f.tx),1);
  assert.equal(f.queued[0].email,"cori@campus2care.org");
});
test("leadership escalation is addressed only to designated president account",async()=>{
  const f=fixture("leadership_escalation");
  assert.equal(await f.service.queueDueProductionStaffEmails(f.tx),1);
  assert.equal(f.queued[0].email,"president@campus2care.org");
});
test("staff mailer never accepts non-Workspace recipient before any API request",async()=>{
  const f=fixture();
  await assert.rejects(f.service.sendProductionStaffMessage({
    operationKey:"dispatch:ea_request:2026-10-29:person",
    recipient:"outsider@example.org",kind:"ea_request",
  }),/staff_recipient_invalid/);
});
