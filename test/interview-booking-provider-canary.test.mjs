import test from "node:test";
import assert from "node:assert/strict";
import {loadInterviewModule} from "./interview-test-loader.mjs";

const service=loadInterviewModule("interview-booking-provider-canary",{
  "./interview-google-provider-auth":{googleProviderAccessToken:async()=>{throw Error("provider must not be called");}},
  "./interview-email":{renderInterviewMessage:()=>{throw Error("email must not be rendered");}},
  "./interview-production-verification-gate":{
    productionVerificationCanaryConfig:()=>({databaseUrl:"postgres://test:unusable@ep-fake.neon.tech/test"}),
    productionVerificationCanaryDatabase:()=>{throw Error("database must not be opened");},
    assertProductionVerificationIdentity:()=>{throw Error("test identity must not be touched");},
  },
  "./interview-production-notion":{verifyLiveCanaryApplicant:async()=>{throw Error("Notion must not be called");}},
  "./interview-notion-contract":{
    assertCampusPipelineParent:()=>{},
    confirmedInterviewNotionProperties:()=>({}),
  },
});
const base={
  INTERVIEW_BOOKING_PROVIDER_CANARY_ENABLED:"true",
  INTERVIEW_BOOKING_PROVIDER_CANARY_EMAIL_APPROVED:"true",
  INTERVIEW_NOTION_LIVE_TOKEN:"not-a-real-token-for-tests-only-0123456789",
};
test("booking provider canary is separately disabled by default",()=>{
  assert.throws(()=>service.bookingProviderCanaryConfig({
    ...base,INTERVIEW_BOOKING_PROVIDER_CANARY_ENABLED:"false",
  }),/booking_provider_canary_disabled/);
});
test("booking provider canary requires independent test-only email approval",()=>{
  assert.throws(()=>service.bookingProviderCanaryConfig({
    ...base,INTERVIEW_BOOKING_PROVIDER_CANARY_EMAIL_APPROVED:"false",
  }),/booking_provider_canary_email_not_approved/);
});
test("booking provider canary requires dedicated Notion credential",()=>{
  assert.throws(()=>service.bookingProviderCanaryConfig({
    ...base,INTERVIEW_NOTION_LIVE_TOKEN:"",
  }),/booking_provider_notion_not_configured/);
});
test("booking provider canary is fixed to one BU test identity outside approved week",()=>{
  const cfg=service.bookingProviderCanaryConfig(base);
  assert.equal(cfg.pageId,"408d6c55a9de81da9063fe9a32d88d9b");
  assert.equal(cfg.recipient,"contact+interview-canary-bu@campus2care.org");
  assert.equal(cfg.start,"2026-11-09T19:00:00.000Z");
  assert.equal(cfg.end,"2026-11-09T19:20:00.000Z");
  assert.ok(Date.parse(cfg.start)>Date.parse("2026-11-08T23:59:59.000Z"));
});
test("disabled canary cannot call any real providers or database",async()=>{
  const old={...process.env};
  try{
    process.env.INTERVIEW_BOOKING_PROVIDER_CANARY_ENABLED="false";
    await assert.rejects(service.runBookingProviderCanary(),/booking_provider_canary_disabled/);
    await assert.rejects(service.cleanupBookingProviderCanary(),/booking_provider_canary_disabled/);
    await assert.rejects(service.bookingProviderCanaryStatus(),/booking_provider_canary_disabled/);
  }finally{
    process.env.INTERVIEW_BOOKING_PROVIDER_CANARY_ENABLED=old.INTERVIEW_BOOKING_PROVIDER_CANARY_ENABLED??"";
  }
});
