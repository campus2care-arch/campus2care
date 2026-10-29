import test from "node:test";
import assert from "node:assert/strict";
import {loadInterviewModule} from "./interview-test-loader.mjs";
const lib=loadInterviewModule("interview-provider-store");
const env={VERCEL_ENV:"production",INTERVIEW_DATA_ENV:"production",INTERVIEW_PROVIDER_AUTH_ENABLED:"true",
 INTERVIEW_DATABASE_URL:"postgres://test:fake@ep-test.neon.tech/neondb?sslmode=require",INTERVIEW_DATABASE_HOST:"ep-test.neon.tech"};
test("production provider authorization is independent of booking switches but requires explicit production scope",()=>{
 assert.equal(lib.providerAuthorizationEnabled(env),true);
 assert.match(lib.productionProviderConnection(env),/ep-test/);
 for(const update of [{INTERVIEW_PROVIDER_AUTH_ENABLED:"false"},{INTERVIEW_DATA_ENV:"staging"},{VERCEL_ENV:"development"},{INTERVIEW_DATABASE_HOST:"ep-other.neon.tech"},{INTERVIEW_DATABASE_URL:"postgres://x:y@ep-test.neon.tech/db?sslmode=disable"}])
  assert.throws(()=>lib.productionProviderConnection({...env,...update}));
 assert.equal(lib.providerAuthorizationEnabled({...env,VERCEL_ENV:"preview",INTERVIEW_PROVIDER_AUTH_ENABLED:"false"}),true);
});
