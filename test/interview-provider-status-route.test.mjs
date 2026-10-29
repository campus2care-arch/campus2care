import test from "node:test";
import assert from "node:assert/strict";
import {loadInterviewModule} from "./interview-test-loader.mjs";

function fixture({enabled=true, role="admin", trusted=true, failure}={}) {
  const calls=[];
  const route=loadInterviewModule("../app/api/interview/providers/google/status/route", {
    "next/server": {NextResponse:{json:(body,options={})=>({body,status:options.status??200,headers:options.headers})}},
    "../../../../../../lib/interview-provider-store": {providerAuthorizationEnabled:()=>enabled},
    "../../../../../../lib/interview-auth": {
      staffFromRequest:()=>role ? {role} : null,
      interviewBaseOrigin:()=>{if(!trusted) throw new Error("untrusted");},
    },
    "../../../../../../lib/interview-google-provider-auth": {
      providerDetails:provider=>({email:provider+"@example.test",scopes:[provider]}),
      googleProviderAccessToken:async provider=>{
        calls.push(provider);
        if(provider===failure) throw new Error("secret-error-must-not-leak");
        return "secret-access-token-must-not-leak";
      },
    },
  });
  return {route,calls};
}

test("provider checks reject disabled, unauthorized and foreign-origin requests before refresh",async()=>{
  for(const [settings,status] of [[{enabled:false},404],[{role:null},403],[{role:"ea"},403],[{trusted:false},403]]) {
    const {route,calls}=fixture(settings);
    assert.equal((await route.GET({})).status,status);
    assert.deepEqual(calls,[]);
  }
});

test("provider status checks both grants without exposing access tokens or provider errors",async()=>{
  for(const failure of [undefined,"calendar","gmail"]) {
    const {route,calls}=fixture({failure});
    const result=await route.GET({});
    assert.equal(result.status,200);
    assert.equal(result.headers["Cache-Control"],"no-store");
    assert.deepEqual(calls,["calendar","gmail"]);
    assert.equal(result.body.checks.length,2);
    for(const check of result.body.checks) assert.equal(check.verified,check.provider!==failure);
    assert.doesNotMatch(JSON.stringify(result),/secret-/);
  }
});
