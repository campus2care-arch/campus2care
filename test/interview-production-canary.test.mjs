import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const src = await readFile(new URL("../lib/interview-production-canary.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const gate = await import("data:text/javascript;base64,"+Buffer.from(js).toString("base64"));

function enabled() {
  return {
    VERCEL_ENV:"production", INTERVIEW_DATA_ENV:"production",
    INTERVIEW_PRODUCTION_ENABLED:"true",INTERVIEW_BOOKING_ENABLED:"true",
    INTERVIEW_PRODUCTION_CANARY_ENABLED:"true",INTERVIEW_PRODUCTION_WORKER_ADAPTER_READY:"true",
    INTERVIEW_OUTREACH_ENABLED:"false",INTERVIEW_PRODUCTION_ENROLLMENT_ENABLED:"false",
    INTERVIEW_CALENDAR_WRITES_ENABLED:"true",INTERVIEW_GMAIL_SENDS_ENABLED:"true",
    INTERVIEW_NOTION_WRITES_ENABLED:"true",INTERVIEW_OUTBOX_WORKER_ENABLED:"true",
    INTERVIEW_DATABASE_URL:"postgres://test_user:fake_password@ep-prod.us-east-1.aws.neon.tech/c2c?sslmode=require",
    INTERVIEW_DATABASE_HOST:"ep-prod.us-east-1.aws.neon.tech",
    INTERVIEW_PRODUCTION_CANARY_EMAILS:"test@campus2care.org",
    INTERVIEW_PRODUCTION_CANARY_PAGE_IDS:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  };
}
test("production canary requires exact Vercel environment and explicit launch switches",()=>{
  for(const patch of [
    {VERCEL_ENV:"preview"},{VERCEL_ENV:"development"},
    {INTERVIEW_DATA_ENV:"staging"},{INTERVIEW_PRODUCTION_ENABLED:"false"},
    {INTERVIEW_BOOKING_ENABLED:"false"},{INTERVIEW_PRODUCTION_CANARY_ENABLED:"false"},
    {INTERVIEW_PRODUCTION_WORKER_ADAPTER_READY:"false"},
    {INTERVIEW_OUTREACH_ENABLED:"true"},{INTERVIEW_PRODUCTION_ENROLLMENT_ENABLED:"true"},
  ])assert.throws(()=>gate.productionCanaryConfig({...enabled(),...patch}),/canary_disabled/);
});
test("provider outages or absent write workers must prevent orphaned reservations",()=>{
  for(const key of ["INTERVIEW_CALENDAR_WRITES_ENABLED","INTERVIEW_GMAIL_SENDS_ENABLED","INTERVIEW_NOTION_WRITES_ENABLED","INTERVIEW_OUTBOX_WORKER_ENABLED"]){
    assert.throws(()=>gate.productionCanaryConfig({...enabled(),[key]:"false"}),/providers_unready/);
  }
});
test("database connection must exactly match configured Neon production host",()=>{
  for(const patch of [
    {INTERVIEW_DATABASE_HOST:"ep-preview.us-east-1.aws.neon.tech"},
    {INTERVIEW_DATABASE_URL:"postgres://test:password@attacker.example/c2c"},
    {INTERVIEW_DATABASE_URL:"postgres://test:password@ep-prod.us-east-1.aws.neon.tech/c2c?sslmode=disable"},
    {INTERVIEW_DATABASE_URL:""},
  ])assert.throws(()=>gate.productionCanaryConfig({...enabled(),...patch}),/database_invalid/);
});
test("canary requires both exact Workspace test email and exact Notion test page",()=>{
  const p="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  assert.deepEqual(gate.assertProductionCanaryIdentity("BU","TEST@campus2care.org",p,enabled()),{
    campus:"BU", email:"test@campus2care.org",pageId:"a".repeat(32)
  });
  assert.throws(()=>gate.assertProductionCanaryIdentity("BU","someoneelse@campus2care.org",p,enabled()),/identity_denied/);
  assert.throws(()=>gate.assertProductionCanaryIdentity("BU","test@campus2care.org","b".repeat(32),enabled()),/identity_denied/);
  assert.throws(()=>gate.assertProductionCanaryIdentity("other","test@campus2care.org",p,enabled()),/invalid_campus/);
  assert.throws(()=>gate.productionCanaryConfig({...enabled(),INTERVIEW_PRODUCTION_CANARY_EMAILS:"applicant@gmail.com"}),/allowlist_missing/);
  assert.throws(()=>gate.productionCanaryConfig({...enabled(),INTERVIEW_PRODUCTION_CANARY_PAGE_IDS:""}),/allowlist_missing/);
});
