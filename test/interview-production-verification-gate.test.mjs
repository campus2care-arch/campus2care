import test from "node:test";
import assert from "node:assert/strict";
import { loadInterviewModule } from "./interview-test-loader.mjs";

const gate = loadInterviewModule("interview-production-verification-gate");
const fixture = {
  VERCEL_ENV:"production",INTERVIEW_DATA_ENV:"production",
  INTERVIEW_PROVIDER_AUTH_ENABLED:"true",
  INTERVIEW_PRODUCTION_VERIFICATION_CANARY_ENABLED:"true",
  INTERVIEW_PRODUCTION_VERIFICATION_SENDS_APPROVED:"false",
  INTERVIEW_PRODUCTION_ENABLED:"false",INTERVIEW_BOOKING_ENABLED:"false",
  INTERVIEW_OUTREACH_ENABLED:"false",INTERVIEW_PRODUCTION_ENROLLMENT_ENABLED:"false",
  INTERVIEW_CALENDAR_WRITES_ENABLED:"false",INTERVIEW_GMAIL_SENDS_ENABLED:"false",
  INTERVIEW_NOTION_WRITES_ENABLED:"false",INTERVIEW_OUTBOX_WORKER_ENABLED:"false",
  INTERVIEW_DATABASE_HOST:"ep-safe.neon.tech",
  INTERVIEW_DATABASE_URL:"postgres://test:unit-only@ep-safe.neon.tech/test?sslmode=require",
  INTERVIEW_PRODUCTION_CANARY_EMAILS:"contact+interview-canary-bu@campus2care.org,contact+interview-canary-bc@campus2care.org",
  INTERVIEW_PRODUCTION_CANARY_PAGE_IDS:"408d6c55a9de81da9063fe9a32d88d9b,408d6c55a9de8164b8faf8d438c8fa71",
};

test("OTP-only gate accepts provider auth with all broad write switches disabled",()=>{
  const config=gate.productionVerificationCanaryConfig(fixture);
  assert.equal(config.emailSendsApproved,false);
  assert.equal(gate.productionVerificationCanaryConfig({...fixture,INTERVIEW_PRODUCTION_VERIFICATION_SENDS_APPROVED:"true"}).emailSendsApproved,true);
});

test("OTP-only gate rejects enabled calendar, Gmail, Notion, worker, booking or outreach",()=>{
  for(const key of [
    "INTERVIEW_PRODUCTION_ENABLED","INTERVIEW_BOOKING_ENABLED","INTERVIEW_OUTREACH_ENABLED",
    "INTERVIEW_PRODUCTION_ENROLLMENT_ENABLED","INTERVIEW_CALENDAR_WRITES_ENABLED",
    "INTERVIEW_GMAIL_SENDS_ENABLED","INTERVIEW_NOTION_WRITES_ENABLED","INTERVIEW_OUTBOX_WORKER_ENABLED"
  ]){
    assert.throws(()=>gate.productionVerificationCanaryConfig({...fixture,[key]:"true"}),/broad_writes_must_be_disabled/);
  }
});

test("OTP-only gate requires explicit enable and genuine production host",()=>{
  for(const patch of [
    {VERCEL_ENV:"preview"},
    {INTERVIEW_DATA_ENV:"preview"},
    {INTERVIEW_PROVIDER_AUTH_ENABLED:"false"},
    {INTERVIEW_PRODUCTION_VERIFICATION_CANARY_ENABLED:"false"},
  ]){
    assert.throws(()=>gate.productionVerificationCanaryConfig({...fixture,...patch}),/canary_disabled/);
  }
  for(const patch of [
    {INTERVIEW_DATABASE_HOST:"ep-other.neon.tech"},
    {INTERVIEW_DATABASE_URL:"postgres://test:unit-only@other.invalid/test"},
  ]){
    assert.throws(()=>gate.productionVerificationCanaryConfig({...fixture,...patch}),/database_invalid/);
  }
});

test("OTP-only gate requires exactly two approved test-email and page-ID values",()=>{
  for(const patch of [
    {INTERVIEW_PRODUCTION_CANARY_EMAILS:"realperson@campus2care.org"},
    {INTERVIEW_PRODUCTION_CANARY_PAGE_IDS:"abc"},
    {INTERVIEW_PRODUCTION_CANARY_EMAILS:fixture.INTERVIEW_PRODUCTION_CANARY_EMAILS+",someone@campus2care.org"},
  ]){
    assert.throws(()=>gate.productionVerificationCanaryConfig({...fixture,...patch}),/allowlist_invalid/);
  }
});

test("live test identity accepts only the two internal system-test records, without the pre-launch flag gate", () => {
  assert.deepEqual(gate.assertLiveTestIdentity("BU","contact+interview-canary-bu@campus2care.org","408d6c55-a9de-81da-9063-fe9a32d88d9b"),
    {campus:"BU",email:"contact+interview-canary-bu@campus2care.org",pageId:"408d6c55a9de81da9063fe9a32d88d9b"});
  assert.throws(()=>gate.assertLiveTestIdentity("BC","contact+interview-canary-bu@campus2care.org","408d6c55a9de81da9063fe9a32d88d9b"),/denied/);
  assert.throws(()=>gate.assertLiveTestIdentity("BU","someone@bu.edu","408d6c55a9de81da9063fe9a32d88d9b"),/denied/);
  assert.equal(gate.isProductionTestRecord("BC","408d6c55a9de8164b8faf8d438c8fa71"),true);
  assert.equal(gate.isProductionTestRecord("BU","408d6c55a9de8164b8faf8d438c8fa71"),false);
});
