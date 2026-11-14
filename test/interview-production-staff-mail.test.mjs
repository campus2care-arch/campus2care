import test from "node:test";
import assert from "node:assert/strict";
import {loadInterviewModule} from "./interview-test-loader.mjs";

function fixture(kind="ea_request",options={}){
  process.env.INTERVIEW_REAL_STAFF_EMAILS_APPROVED="true";
  const seen=new Set(),queued=[],queries=[];
  const tx=async(parts,...args)=>{
    const text=parts.join("?");
    queries.push(text);
    if(text.includes("INSERT INTO interview.dispatch_run")){
      if(seen.has(args[0]))return [];
      seen.add(args[0]);return [{id:"11111111-1111-1111-1111-111111111111"}];
    }
    if(text.includes("FROM interview.interviewer i"))return options.staff ?? [
      {id:"22222222-2222-2222-2222-222222222222",workspace_email:"cori@campus2care.org",status:null},
      {id:"33333333-3333-3333-3333-333333333333",workspace_email:"sophia@campus2care.org",status:"confirmed"},
    ];
    if(text.includes("INSERT INTO interview.message")){
      queued.push({key:args[0],email:args[1],kind:args[2],objectId:args[3],payload:args[4]});
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
    "./interview-auth":{authorizedRole:options.authorizedRole ??
      ((email)=>email.endsWith("@campus2care.org")?"ea":null)},
    "./interview-dispatch-policy":{dueInterviewDispatches:()=>[
      {kind,runKey:kind+":2026-10-29",weekStart:"2026-11-02"}]},
    "./interview-production-providers":{productionGoogleAccessToken:async()=>{throw Error("unexpected token request");}},
  });
  return {service,tx,seen,queued,queries};
}
test("production staff notifications need separately approved flag",async()=>{
  const f=fixture();
  process.env.INTERVIEW_REAL_STAFF_EMAILS_APPROVED="false";
  await assert.rejects(f.service.queueDueProductionStaffEmails(f.tx),/not_approved/);
  assert.equal(f.queued.length,0);
});
test("Wednesday requests reach authorized EA roster entries exactly once per key",async()=>{
  const f=fixture("ea_request");
  assert.equal(await f.service.queueDueProductionStaffEmails(f.tx),2);
  assert.equal(await f.service.queueDueProductionStaffEmails(f.tx),0);
  assert.equal(f.queued.length,2);
  assert.deepEqual(f.queued.map(x=>x.kind),["ea_request","ea_request"]);
  assert.match(f.queued[0].key,/^dispatch:ea_request:2026-10-29:/);
  const roster=f.queries.find(sql=>sql.includes("FROM interview.interviewer i"));
  assert.match(roster,/i\.role IN \('ea','admin'\)/);
  assert.match(roster,/i\.active/);
  assert.match(roster,/i\.staff_access/);
  assert.match(roster,/i\.removed_at IS NULL/);
  assert.match(roster,/i\.workspace_email LIKE '%@campus2care\.org'/);
});
test("active admin leads with a non-null authorizedRole are queued once",async()=>{
  const adminId="44444444-4444-4444-4444-444444444444";
  const f=fixture("ea_request",{
    staff:[
      {id:adminId,workspace_email:"president@campus2care.org",status:null,role:"admin"},
      {id:"55555555-5555-5555-5555-555555555555",workspace_email:"former@campus2care.org",status:null,role:"admin"},
    ],
    authorizedRole:email=>email==="president@campus2care.org"?"admin":null,
  });
  assert.equal(await f.service.queueDueProductionStaffEmails(f.tx),1);
  assert.equal(await f.service.queueDueProductionStaffEmails(f.tx),0);
  assert.equal(f.queued.length,1);
  assert.equal(f.queued[0].email,"president@campus2care.org");
  assert.equal(f.queued[0].kind,"ea_request");
  assert.equal(f.queued[0].key,"dispatch:ea_request:2026-10-29:"+adminId);
});
test("staff outbox claim uses the same admin, access, and workspace filter",async()=>{
  const f=fixture("ea_request");
  const seen=[];
  const db=async(parts)=>{seen.push(parts.join("?"));return [];};
  db.begin=fn=>fn(db);
  assert.deepEqual(await f.service.processProductionStaffOutbox(db,1,async()=>{
    throw Error("must not send");
  }),{claimed:0,done:0,reconciliation:0});
  const claim=seen.find(sql=>sql.includes("WITH candidate AS"));
  assert.match(claim,/i\.role IN \('ea','admin'\) AND i\.active/);
  assert.match(claim,/i\.staff_access AND i\.removed_at IS NULL/);
  assert.match(claim,/i\.workspace_email LIKE '%@campus2care\.org'/);
  assert.match(claim,/authorizedRole|m\.recipient_ref=i\.workspace_email/);
});
test("Thursday reminder skips staff with confirmed weekly availability",async()=>{
  const f=fixture("ea_reminder");
  assert.equal(await f.service.queueDueProductionStaffEmails(f.tx),1);
  assert.equal(f.queued[0].email,"cori@campus2care.org");
});
test("leadership escalation does not require a fake president interviewer row",async()=>{
  const f=fixture("leadership_escalation");
  assert.equal(await f.service.queueDueProductionStaffEmails(f.tx),1);
  assert.equal(f.queued[0].email,"president@campus2care.org");
  assert.equal(f.queued[0].objectId,"11111111-1111-1111-1111-111111111111");
  assert.equal(f.queued[0].payload.missingCount,1);
  assert.equal(await f.service.queueDueProductionStaffEmails(f.tx),0);
});
test("leadership escalation worker recognizes dispatch-owned identity and delivers once",async()=>{
  const f=fixture("leadership_escalation");
  let claims=0,delivered=0;
  const messageId="55555555-5555-5555-5555-555555555555";
  const db=async (parts)=>{
    const sql=parts.join("?");
    if(sql.includes("WITH candidate AS")){
      assert.match(sql,/LEFT JOIN interview.dispatch_run d ON d.id=m.object_id/);
      assert.match(sql,/d.job_kind='leadership_escalation'/);
      assert.match(sql,/m.operation_key=j.operation_key/);
      if(claims++)return [];
      return [{id:"66666666-6666-6666-6666-666666666666",
        operation_key:"dispatch:leadership_escalation:2026-10-29:11111111-1111-1111-1111-111111111111",
        message_id:messageId,kind:"leadership_escalation",
        recipient_ref:"president@campus2care.org",payload:{missingCount:1}}];
    }
    if(sql.includes("UPDATE interview.message SET state='reconcile_required'"))return [{id:messageId}];
    if(sql.includes("UPDATE interview.message SET state='accepted'")||
       sql.includes("UPDATE interview.integration_outbox SET state='done'"))return [];
    throw Error("unexpected SQL "+sql.slice(0,90));
  };
  db.begin=fn=>fn(db);
  const result=await f.service.processProductionStaffOutbox(db,2,async message=>{
    delivered++;
    assert.equal(message.recipient,"president@campus2care.org");
    assert.equal(message.kind,"leadership_escalation");
    assert.equal(message.missingCount,1);
    return "gmail-confirmed-id";
  });
  assert.equal(delivered,1);
  assert.deepEqual(result,{claimed:1,done:1,reconciliation:0});
});
test("staff mailer never accepts non-Workspace recipient before any API request",async()=>{
  const f=fixture();
  await assert.rejects(f.service.sendProductionStaffMessage({
    operationKey:"dispatch:ea_request:2026-10-29:person",
    recipient:"outsider@example.org",kind:"ea_request",
  }),/staff_recipient_invalid/);
});
