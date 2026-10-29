import test from "node:test";
import assert from "node:assert/strict";
import { loadInterviewModule } from "./interview-test-loader.mjs";

const provider=loadInterviewModule("interview-production-providers",{
  "./interview-production-canary":{
    productionCanaryConfig:()=>({}),
    assertProductionCanaryIdentity:(campus,email,page)=>{
      if(campus!=="BU"||email!=="test@campus2care.org"||page!=="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")throw Error("not canary");
    },
  },
});
const id="11111111-1111-1111-1111-111111111111";
const operationKey="interview-calendar:create:"+id;
const eventId=provider.productionCalendarEventId(operationKey);
const input={
  operationKey,reservationId:id,campus:"BU",pageId:"a".repeat(32),applicantEmail:"test@campus2care.org",
  participants:[
    {email:"cori@campus2care.org",role:"lead"},
    {email:"sarah@campus2care.org",role:"shadow"},
  ],
  startsAt:"2026-11-02T18:00:00.000Z",endsAt:"2026-11-02T18:20:00.000Z",
};
function setup(){
  Object.assign(process.env,{
    INTERVIEW_PRODUCTION_CALENDAR_REFRESH_TOKEN:"r".repeat(40),
    INTERVIEW_PRODUCTION_GMAIL_REFRESH_TOKEN:"g".repeat(40),
    INTERVIEW_GOOGLE_CLIENT_ID:"client-id-test",INTERVIEW_GOOGLE_CLIENT_SECRET:"client-secret-test",
    INTERVIEW_NOTION_LIVE_TOKEN:"n".repeat(40),
    INTERVIEW_PRODUCTION_CALENDAR_INVITES_APPROVED:"true",
  });
}
function googleFetch({existing=false,pending=false,wrongAccount=false}={}){
  const calls=[];
  const transport=async(url,opts)=>{
    calls.push({url,opts});
    if(url==="https://oauth2.googleapis.com/token")return Response.json({access_token:"x".repeat(40)});
    if(url.includes("/userinfo"))return Response.json({email:wrongAccount?"hacker@example.com":"interviews@campus2care.org",email_verified:true});
    if(url.includes("/events/"+eventId)){
      if(!existing)return new Response(null,{status:404});
      return Response.json({id:eventId,status:"confirmed",extendedProperties:{private:{c2cOperationKey:operationKey}},
        conferenceData:pending?{}:{entryPoints:[{entryPointType:"video",uri:"https://meet.google.com/abc-defg-hij"}]}});
    }
    if(url.includes("/events?")){
      const body=JSON.parse(opts.body);
      assert.equal(body.attendees.length,3);
      assert.equal(body.conferenceData.createRequest.conferenceSolutionKey.type,"hangoutsMeet");
      assert.equal(body.end.dateTime,input.endsAt);
      assert.ok(url.includes("sendUpdates=all"));
      return Response.json({id:eventId,status:"confirmed",extendedProperties:{private:{c2cOperationKey:operationKey}},
        conferenceData:{entryPoints:[{entryPointType:"video",uri:"https://meet.google.com/abc-defg-hij"}]}});
    }
    throw Error("unexpected call "+url);
  };
  return {calls,transport};
}
test("Calendar event creation is deterministic and invites applicant, lead and shadower",async()=>{
  setup();const mock=googleFetch();
  const event=await provider.createOrReadProductionInterviewEvent(input,mock.transport);
  assert.equal(event.id,eventId);
  assert.equal(event.meetUrl,"https://meet.google.com/abc-defg-hij");
  assert.equal(mock.calls.filter(x=>x.opts.method==="POST"&&x.url.includes("/events?")).length,1);
});
test("retries use GET and never insert a second event; Meet may be pending",async()=>{
  setup();const mock=googleFetch({existing:true,pending:true});
  const event=await provider.createOrReadProductionInterviewEvent(input,mock.transport);
  assert.equal(event.meetUrl,null);
  assert.equal(mock.calls.filter(x=>x.url.includes("/events?")).length,0);
});
test("wrong Calendar OAuth identity is rejected before event writes",async()=>{
  setup();
  await assert.rejects(provider.createOrReadProductionInterviewEvent(input,googleFetch({wrongAccount:true}).transport),/wrong_account/);
});
function notionPage(){
  return {id:"a".repeat(32),parent:{type:"database_id",database_id:"03192649741442fe86acdddcc7320798"},
    properties:{
      Email:{email:"test@campus2care.org"},
      Stage:{select:{name:"Needs Interview"}},
      "Next Step":{select:{name:"Schedule interview"}},
      "Workflow Status":{select:{name:"Application Received"}},
      "Interview Status":{select:{name:"Not Scheduled"}},
      "Scheduling Reservation ID":{rich_text:[]},
    }};
}
const notionInput={campus:"BU",pageId:"a".repeat(32),applicantEmail:"test@campus2care.org",reservationId:id,
  startsAt:input.startsAt,interviewerEmail:"cori@campus2care.org",meetUrl:"https://meet.google.com/abc-defg-hij"};
test("live Notion write patches interview-only fields and rejects other bookings",async()=>{
  setup();const calls=[];
  const transport=async(url,opts)=>{
    calls.push(opts);
    if(!opts.method)return Response.json(notionPage());
    const body=JSON.parse(opts.body);
    assert.ok(body.properties["Interview Status"]);
    assert.equal(body.properties["Executive Associate Owner"],undefined);
    assert.equal(body.properties["Interview Notes"],undefined);
    return Response.json({id:"a".repeat(32)});
  };
  const result=await provider.syncProductionInterviewNotion(notionInput,transport);
  assert.equal(result,"written");
  assert.equal(calls.length,2);
  const conflict=notionPage();
  conflict.properties["Scheduling Reservation ID"].rich_text=[{plain_text:"other-id"}];
  await assert.rejects(provider.syncProductionInterviewNotion(notionInput,async()=>Response.json(conflict)),/other_booking/);
});
test("Gmail uses contact account and correct canary recipient; returns acceptance ID",async()=>{
  setup();const calls=[];
  const transport=async(url,opts)=>{
    calls.push(url);
    if(url.includes("oauth2.googleapis"))return Response.json({access_token:"x".repeat(40)});
    if(url.includes("/userinfo"))return Response.json({email:"contact@campus2care.org",email_verified:true});
    if(url.includes("messages/send")){
      const sent=Buffer.from(JSON.parse(opts.body).raw,"base64url").toString();
      assert.ok(sent.includes("To: test@campus2care.org"));
      assert.ok(sent.includes("From: Campus2Care <contact@campus2care.org>"));
      return Response.json({id:"abc123"});
    }
    throw Error("bad URL");
  };
  const result=await provider.sendProductionInterviewConfirmation({
    operationKey:"interview-mail:confirmation:"+id, reservationId:id,
    campus:"BU",pageId:"a".repeat(32),email:"test@campus2care.org",
    startsAt:input.startsAt,meetUrl:notionInput.meetUrl,
  },transport);
  assert.equal(result,"abc123");
  assert.equal(calls.length,3);
});

test("Calendar cancellation verifies ownership and treats absent or canceled events idempotently",async()=>{
 setup();
 for(const state of ["confirmed","cancelled","missing","wrong-owner"]){
  let deleted=0;
  const transport=async(url,options)=>{
   if(url.includes("/token"))return Response.json({access_token:"x".repeat(40)});
   if(url.includes("/userinfo"))return Response.json({email:"interviews@campus2care.org",email_verified:true});
   if(options.method==="DELETE"){deleted++;assert.ok(url.endsWith("?sendUpdates=all"));return new Response(null,{status:204});}
   if(state==="missing")return new Response(null,{status:404});
   if(state==="cancelled")return Response.json({id:eventId,status:"cancelled"});
   return Response.json({id:eventId,status:"confirmed",extendedProperties:{private:{c2cOperationKey:state==="wrong-owner"?"other":operationKey}}});
  };
  const call=()=>provider.cancelProductionInterviewEvent(input,transport);
  if(state==="wrong-owner")await assert.rejects(call,/event_mismatch/);else await call();
  assert.equal(deleted,state==="confirmed"?1:0);
 }
});

test("Notion cancellation clears only its booking and preserves workflow or ownership conflicts",async()=>{
 setup();
 for(const mode of ["scheduled","cleared","other-booking","withdrawn"]){
  let patches=0;
  const fields={Email:{email:input.applicantEmail},Stage:{select:{name:"Needs Interview"}},
   "Next Step":{select:{name:"Schedule interview"}},"Workflow Status":{select:{name:mode==="withdrawn"?"Paused":"Interview Scheduled"}},
   "Interview Status":{select:{name:mode==="cleared"?"Not Scheduled":"Scheduled"}},
   "Scheduling Reservation ID":{rich_text:mode==="cleared"?[]:[{plain_text:mode==="other-booking"?"other":id}]},
   "Interview Date":{date:mode==="cleared"?null:{start:input.startsAt}},"Google Meet URL":{url:mode==="cleared"?null:calendarUrl()}};
  const transport=async(_url,options)=>{
   if(options.method==="PATCH"){
    patches++;const patch=JSON.parse(options.body).properties;
    assert.deepEqual(Object.keys(patch).sort(),["Google Meet URL","Interview Date","Interview Status","Scheduling Reservation ID","Workflow Status"].sort());
    assert.equal(patch["Interview Date"].date,null);return Response.json({});
   }
   return Response.json({id:input.pageId,parent:{type:"database_id",database_id:"03192649741442fe86acdddcc7320798"},properties:fields});
  };
  const call=()=>provider.clearProductionInterviewNotion({...input,reservationId:id},transport);
  if(["other-booking","withdrawn"].includes(mode))await assert.rejects(call,/cancellation_conflict/);else await call();
  assert.equal(patches,mode==="scheduled"?1:0);
 }
});
function calendarUrl(){return "https://meet.google.com/abc-defg-hij";}
