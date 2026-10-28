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
