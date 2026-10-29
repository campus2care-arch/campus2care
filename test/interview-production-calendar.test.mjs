import test from "node:test";
import assert from "node:assert/strict";
import {loadInterviewModule} from "./interview-test-loader.mjs";
const calendar=loadInterviewModule("interview-production-calendar",{
 "./interview-production-canary":{productionCanaryConfig:()=>({})},
});
const people=[
 {id:"a",email:"cori.miller@campus2care.org",name:"Cori",role:"lead",available:true},
 {id:"b",email:"sarah@campus2care.org",name:"Sarah",role:"shadow",available:true},
];
const start="2026-11-02T18:00:00.000Z",end="2026-11-02T18:20:00.000Z";
function configured() {
 Object.assign(process.env,{
  INTERVIEW_PRODUCTION_CALENDAR_READS_ENABLED:"true",
  INTERVIEW_PRODUCTION_CALENDAR_REFRESH_TOKEN:"r".repeat(40),
  INTERVIEW_GOOGLE_CLIENT_ID:"client-id-testing",
  INTERVIEW_GOOGLE_CLIENT_SECRET:"client-secret-testing",
 });
}
function transport({wrongAccount=false,busy=false,missing=false}={}){
 const calls=[];
 const fetch=async(url,init)=>{
   calls.push({url,init});
   if(url.includes("oauth2.googleapis.com/token"))return Response.json({access_token:"t".repeat(40)});
   if(url.includes("openidconnect.googleapis.com"))return Response.json({
     email:wrongAccount?"other@campus2care.org":"interviews@campus2care.org",email_verified:true,
   });
   if(url.includes("/freeBusy")){
     const body=JSON.parse(init.body);
     assert.equal(body.items.length,2);
     assert.equal(body.timeZone,"America/New_York");
     const entries={
       "cori.miller@campus2care.org":{busy:[]},
       "sarah@campus2care.org":missing?{errors:[{reason:"notFound"}]}:
         {busy:busy?[{start:"2026-11-02T18:10:00Z",end:"2026-11-02T18:15:00Z"}]:[]},
     };
     return Response.json({calendars:entries});
   }
   throw Error("unexpected URL");
 };
 return {fetch,calls};
}
test("calendar adapter reads both lead and shadower availability using the interviews account",async()=>{
 configured();const mock=transport();
 await calendar.checkProductionCanaryCalendars(people,start,end,mock.fetch);
 assert.equal(mock.calls.length,3);
 assert.ok(mock.calls[0].url.includes("oauth2.googleapis.com/token"));
 assert.equal(mock.calls[0].init.method,"POST");
});
test("shadower conflict or insufficient calendar sharing prevents reservations",async()=>{
 configured();
 await assert.rejects(calendar.checkProductionCanaryCalendars(people,start,end,transport({busy:true}).fetch),/participant_busy/);
 await assert.rejects(calendar.checkProductionCanaryCalendars(people,start,end,transport({missing:true}).fetch),/participant_unavailable/);
});
test("Calendar must belong to exact organization-owned interviews account",async()=>{
 configured();
 await assert.rejects(calendar.checkProductionCanaryCalendars(people,start,end,transport({wrongAccount:true}).fetch),/wrong_account/);
});
test("missing OAuth configuration and unauthorized participant fail before network",async()=>{
 configured();process.env.INTERVIEW_PRODUCTION_CALENDAR_READS_ENABLED="false";
 await assert.rejects(calendar.checkProductionCanaryCalendars(people,start,end,transport().fetch),/reads_disabled/);
 configured();
 await assert.rejects(calendar.checkProductionCanaryCalendars([
  {...people[0],email:"unknown@gmail.com"},people[1],
 ],start,end,transport().fetch),/input_invalid/);
});
