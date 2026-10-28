import test from "node:test";
import assert from "node:assert/strict";
import { loadInterviewModule } from "./interview-test-loader.mjs";

function dispatchFixture(kind, staff) {
  process.env.VERCEL_ENV = "preview";
  process.env.INTERVIEW_SYNTHETIC_DISPATCH_ENABLED = "true";
  process.env.INTERVIEW_BASE_URL = "https://staging.example.org";
  const calls = [], messages = [];
  const completedRuns = new Set();
  const tx = async (strings, ...values) => {
    const sql = strings.join("?");
    calls.push({sql,values});
    if (sql.includes("INSERT INTO interview.dispatch_run")) {
      if (completedRuns.has(values[0])) return [];
      completedRuns.add(values[0]);
      return [{id:"synthetic-run"}];
    }
    if (sql.includes("FROM interview.interviewer i LEFT JOIN interview.interviewer_week w")) {
      // Lock the real interviewer row, not a nonexistent applicant_contact alias.
      assert.match(sql,/FOR UPDATE OF i\s*$/);
      assert.doesNotMatch(sql,/FOR UPDATE OF i,c/);
      return staff;
    }
    if (sql.includes("INSERT INTO interview.message")) messages.push({values});
    return [];
  };
  tx.begin = (run) => run(tx);
  tx.json = (value) => value;
  const service = loadInterviewModule("interview-dispatch", {
    "./interview-db": {interviewDatabase: () => tx},
    "./interview-dispatch-policy": {
      dueInterviewDispatches: () => [{runKey:kind+":2026-10-28",kind,weekStart:"2026-11-02"}],
      routineOutreachDecision: () => "eligible",
    },
    "./interview-secrets": {sealInterviewSecret: () => ({})},
  });
  return {service,calls,messages};
}

test("Wednesday EA request locks the correct table and queues only the synthetic account", async () => {
  const f = dispatchFixture("ea_request", [
    {id:"bob-id",workspace_email:"bob@campus2care.org",status:null},
    {id:"other-id",workspace_email:"other@campus2care.org",status:null},
  ]);
  assert.deepEqual(await f.service.dispatchSyntheticInterviewMessages(new Date("2026-10-28T19:00:00Z")), {queued:1,skipped:1});
  assert.equal(f.messages.length,1);
  assert.equal(f.messages[0].values[2],"bob@campus2care.org");
  // Per-local-day idempotency: second scheduler invocation must not enqueue more mail.
  assert.deepEqual(await f.service.dispatchSyntheticInterviewMessages(new Date("2026-10-28T19:15:00Z")), {queued:0,skipped:0});
  assert.equal(f.messages.length,1);
});

test("Thursday reminder skips confirmed interviewers and all real recipients", async () => {
  const f = dispatchFixture("ea_reminder", [
    {id:"bob-id",workspace_email:"bob@campus2care.org",status:"confirmed"},
    {id:"other-id",workspace_email:"other@campus2care.org",status:null},
  ]);
  assert.deepEqual(await f.service.dispatchSyntheticInterviewMessages(new Date("2026-10-29T22:00:00Z")), {queued:0,skipped:2});
  assert.equal(f.messages.length,0);
});

test("Friday leadership escalation is restricted to the synthetic test mailbox", async () => {
  const f = dispatchFixture("leadership_escalation", [
    {id:"bob-id",workspace_email:"bob@campus2care.org",status:"unavailable"},
    {id:"other-id",workspace_email:"other@campus2care.org",status:null},
  ]);
  assert.deepEqual(await f.service.dispatchSyntheticInterviewMessages(new Date("2026-10-30T15:00:00Z")), {queued:1,skipped:0});
  assert.equal(f.messages.length,1);
  assert.equal(f.messages[0].values[2],"bob@campus2care.org");
  const payload=f.messages[0].values[6];
  assert.equal(payload.missingCount,1);
});

test("delayed Gmail acceptance still enforces the cross-campus 48-hour limit", async () => {
  process.env.VERCEL_ENV="preview";
  process.env.INTERVIEW_SYNTHETIC_DISPATCH_ENABLED="true";
  process.env.INTERVIEW_BASE_URL="https://staging.example.org";
  const calls=[];
  const tx=async (strings,..._values) => {
    void _values;
    const sql=strings.join("?");
    calls.push(sql);
    if(sql.includes("INSERT INTO interview.dispatch_run"))return [{id:"new-run"}];
    if(sql.includes("FROM interview.invitation i JOIN interview.applicant_contact c"))
      return [{id:"synthetic-invite",campus:"BC",notion_page_id:"synthetic-page",recipient_hmac:"a".repeat(64),email:"test@example.invalid"}];
    if(sql.includes("FROM interview.outreach_attempt")) {
      // A send queued over a week ago may have been accepted by Gmail today.
      // The window must consider sent_at as well as created_at.
      return sql.includes("sent_at>now()-interval '7 days'")
        ? [{state:"sent",created_at:new Date("2026-10-27T18:00:00Z"),sent_at:new Date("2026-11-06T18:00:00Z")}]
        : [];
    }
    return [];
  };
  tx.begin=fn=>fn(tx);tx.json=x=>x;
  const policy=loadInterviewModule("interview-dispatch-policy");
  const service=loadInterviewModule("interview-dispatch",{
    "./interview-db":{interviewDatabase:()=>tx},
    "./interview-dispatch-policy":{
      dueInterviewDispatches:()=>[{runKey:"applicant_friday:2026-11-06",kind:"applicant_friday",weekStart:"2026-11-09"}],
      routineOutreachDecision:policy.routineOutreachDecision,
    },
    "./interview-secrets":{sealInterviewSecret:()=>({})},
  });
  assert.deepEqual(await service.dispatchSyntheticInterviewMessages(new Date("2026-11-06T19:00:00Z")),{queued:0,skipped:1});
  assert.equal(calls.some(sql=>sql.includes("FROM interview.interviewer i JOIN interview.interviewer_week w")),false);
  assert.equal(calls.some(sql=>sql.includes("INSERT INTO interview.message")),false);
});

test("a Notion-bound invitation is suppressed when the current pipeline scan no longer approves it",async()=>{
  Object.assign(process.env,{VERCEL_ENV:"preview",INTERVIEW_SYNTHETIC_DISPATCH_ENABLED:"true",
    INTERVIEW_SYNTHETIC_PIPELINE_SCAN_ENABLED:"true",INTERVIEW_BASE_URL:"https://staging.example.org"});
  const pageId="407d6c55a9de815c9363d831bece88f2";
  for(const allowed of [false,true]){
    const calls=[];
    const tx=async(strings,...values)=>{
      const sql=strings.join("?");calls.push(sql);
      if(sql.includes("INSERT INTO interview.dispatch_run"))return [{id:"run"}];
      if(sql.includes("FROM interview.invitation i JOIN interview.applicant_contact c"))
        return [{id:"test-invite",campus:"BC",notion_page_id:"synthetic-"+pageId,
          recipient_hmac:"a".repeat(64),email:"test@example.invalid",bound_page_id:pageId}];
      if(sql.includes("FROM interview.outreach_attempt"))
        return [{state:"sent",created_at:new Date("2026-10-27T15:00:00Z"),sent_at:new Date("2026-10-28T15:00:00Z")}];
      return [];
    };
    tx.begin=fn=>fn(tx);tx.json=x=>x;
    const service=loadInterviewModule("interview-dispatch",{
      "./interview-db":{interviewDatabase:()=>tx},
      "./interview-dispatch-policy":{
        dueInterviewDispatches:()=>[{runKey:"applicant_friday:2026-10-30",kind:"applicant_friday",weekStart:"2026-11-02"}],
        routineOutreachDecision:()=> "spacing_48_hours",
      },
      "./interview-pipeline-enrollment":{
        enrollSyntheticPipelineApplicants:async(_transport,keys)=>{
          if(allowed)keys.add("BC:"+pageId.replaceAll("-","")+":test@example.invalid");
          return {enrolled:0,skipped:allowed?0:1,reviewed:1};
        },
      },
    });
    const outcome=await service.dispatchSyntheticInterviewMessages(new Date("2026-10-30T18:00:00Z"));
    assert.deepEqual(outcome,{queued:0,skipped:1});
    assert.equal(calls.some(sql=>sql.includes("FROM interview.outreach_attempt")),allowed);
    assert.equal(calls.some(sql=>sql.includes("INSERT INTO interview.message")),false);
  }
  delete process.env.INTERVIEW_SYNTHETIC_PIPELINE_SCAN_ENABLED;
});
