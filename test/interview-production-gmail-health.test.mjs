import test from "node:test";
import assert from "node:assert/strict";
import {loadInterviewModule} from "./interview-test-loader.mjs";

const scope="openid email https://www.googleapis.com/auth/gmail.send";

test("contact health uses the sender token path and never calls messages.send",async()=>{
  const previous=process.env.INTERVIEW_PRODUCTION_GMAIL_REFRESH_TOKEN;
  delete process.env.INTERVIEW_PRODUCTION_GMAIL_REFRESH_TOKEN;
  const urls=[];
  const health=loadInterviewModule("interview-production-gmail-health",{
    "./interview-production-providers":{productionGoogleAccessToken:async(_provider,transport)=>{
      const response=await transport("https://oauth2.googleapis.com/token",{method:"POST"});
      const body=await response.json();
      assert.equal(typeof body.access_token,"string");
      return "server-access-token-must-not-leak";
    }},
  });
  try{
    const result=await health.readProductionContactGmailHealth(async(url)=>{
      urls.push(String(url));
      if(String(url).includes("messages/send"))throw Error("mail send forbidden");
      if(String(url).endsWith("/token"))return Response.json({access_token:"secret-access-token",scope});
      return Response.json({email:"contact@campus2care.org",email_verified:true});
    });
    assert.equal(result.ok,true);
    assert.equal(result.readOnly,true);
    assert.equal(result.source,"database");
    assert.equal(result.refresh,"ok");
    assert.equal(result.gmailSend,true);
    assert.equal(result.account,"contact@campus2care.org");
    assert.equal(urls.some(url=>url.includes("messages/send")),false);
    assert.doesNotMatch(JSON.stringify(result),/secret-access-token|server-access-token/);
  }finally{
    if(previous===undefined)delete process.env.INTERVIEW_PRODUCTION_GMAIL_REFRESH_TOKEN;
    else process.env.INTERVIEW_PRODUCTION_GMAIL_REFRESH_TOKEN=previous;
  }
});

test("missing gmail.send is reported from tokeninfo without sending",async()=>{
  process.env.INTERVIEW_PRODUCTION_GMAIL_REFRESH_TOKEN="e".repeat(24);
  const urls=[];
  const health=loadInterviewModule("interview-production-gmail-health",{
    "./interview-production-providers":{productionGoogleAccessToken:async()=>"y".repeat(30)},
  });
  try{
    const result=await health.readProductionContactGmailHealth(async(url)=>{
      urls.push(String(url));
      if(String(url).includes("messages/send"))throw Error("mail send forbidden");
      assert.equal(String(url),"https://oauth2.googleapis.com/tokeninfo");
      return Response.json({scope:"openid email"});
    });
    assert.equal(result.source,"environment");
    assert.equal(result.gmailSend,false);
    assert.equal(result.errorCode,"campaign_gmail_scope_missing");
    assert.equal(urls.length,1);
  }finally{delete process.env.INTERVIEW_PRODUCTION_GMAIL_REFRESH_TOKEN;}
});

test("oauth refresh failure stays a safe pre-send class",async()=>{
  delete process.env.INTERVIEW_PRODUCTION_GMAIL_REFRESH_TOKEN;
  class ProductionProviderError extends Error{
    constructor(code,disposition,httpStatus=null){super(code);this.httpStatus=httpStatus;this.disposition=disposition;}
  }
  const health=loadInterviewModule("interview-production-gmail-health",{
    "./interview-production-providers":{ProductionProviderError,productionGoogleAccessToken:async()=>{
      throw new ProductionProviderError("production_google_oauth_unavailable","retry",400);
    }},
    "./interview-campaign-gmail-disposition":loadInterviewModule("interview-campaign-gmail-disposition",{
      "./interview-production-providers":{ProductionProviderError},
    }),
  });
  const result=await health.readProductionContactGmailHealth(async()=>{throw Error("network forbidden");});
  assert.equal(result.ok,false);
  assert.equal(result.refresh,"failed");
  assert.equal(result.errorCode,"campaign_gmail_oauth_invalid_grant");
  assert.equal(result.httpStatus,400);
  assert.equal(result.gmailSend,false);
});

test("gmail health route is production founder read-only",async t=>{
  const original=process.env.VERCEL_ENV;
  t.after(()=>{if(original===undefined)delete process.env.VERCEL_ENV;else process.env.VERCEL_ENV=original;});
  let calls=0;
  const route=loadInterviewModule("../app/api/interview/admin/production-gmail-health/route",{
    "next/server":{NextResponse:{json:(body,options)=>({body,status:options?.status??200,headers:options?.headers})}},
    "../../../../../lib/interview-auth":{staffFromRequest:()=>staff},
    "../../../../../lib/interview-production-gmail-health":{readProductionContactGmailHealth:async()=>{calls++;return {ok:true,readOnly:true,gmailSend:true};}},
  });
  let staff=null;
  process.env.VERCEL_ENV="preview";
  assert.equal((await route.GET({})).status,404);
  process.env.VERCEL_ENV="production";
  assert.equal((await route.GET({})).status,403);
  staff={role:"admin",email:"other@campus2care.org"};
  assert.equal((await route.GET({})).status,403);
  staff={role:"admin",email:"president@campus2care.org"};
  const ok=await route.GET({});
  assert.equal(ok.status,200);
  assert.equal(ok.body.gmailSend,true);
  assert.equal(calls,1);
  assert.equal(ok.headers["Cache-Control"].includes("no-store"),true);
});
