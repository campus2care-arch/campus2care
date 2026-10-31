import test from "node:test";
import assert from "node:assert/strict";
import { loadInterviewModule } from "./interview-test-loader.mjs";

const pageId="408d6c55a9de81da9063fe9a32d88d9b";
const recipient="contact+interview-canary-bu@campus2care.org";
const reservation="c2c00000-0000-4000-8000-000020261029";
const meet="https://meet.google.com/abc-defg-hij";
const canaryId="c2c-bu-booking-canary-20261029";
process.env.INTERVIEW_BOOKING_PROVIDER_CANARY_ENABLED="true";
process.env.INTERVIEW_BOOKING_PROVIDER_CANARY_EMAIL_APPROVED="true";
process.env.INTERVIEW_NOTION_LIVE_TOKEN="nonsecret-notion-token-unit-test-value";
function fixture(){
  let ledger=null, event=null, status="Not Scheduled", reservationId="",sent=0,notionWrites=0;
  const requests=[];
  const db=async(strings,...params)=>{
    const sql=strings.join("?");
    if(sql.includes("FROM interview.schedule_slot"))return [{total:0}];
    if(sql.includes("INSERT INTO interview.booking_provider_canary")){
      ledger??={id:canaryId,state:"new",calendar_event_id:null,meet_url:null,gmail_message_id:null,email_attempted_at:null};
      return [];
    }
    if(sql.includes("UPDATE interview.booking_provider_canary")){
      const match=sql.match(/SET\s+state='([a-z_]+)'/);
      if(!match)throw Error("unknown transition");
      const stateValue=match[1];
      if(stateValue==="creating_event" && ledger?.state!=="new")return [];
      ledger.state=stateValue;
      if(stateValue==="event_created"){ledger.calendar_event_id=params[0];ledger.meet_url=params[1];}
      if(stateValue==="sending_email")ledger.email_attempted_at=new Date();
      if(stateValue==="complete")ledger.gmail_message_id=params[0];
      return sql.includes("RETURNING id")?[{id:canaryId}]:[];
    }
    if(sql.includes("FROM interview.booking_provider_canary"))return ledger?[{...ledger}]:[];
    throw Error("Unexpected SQL: "+sql.slice(0,70));
  };
  async function transport(url,init={}){
    const method=init.method??"GET";
    requests.push({url,method,init});
    const response=(data,statusCode=200)=>new Response(JSON.stringify(data),{status:statusCode,
      headers:{"content-type":"application/json"}});
    if(url.startsWith("https://api.notion.com/v1/pages/")){
      const props={
        Email:{email:recipient},
        "Interview Status":{select:{name:status}},
        "Scheduling Reservation ID":{rich_text:reservationId?[{plain_text:reservationId}]:[]},
      };
      if(method==="PATCH"){
        const payload=JSON.parse(init.body);
        notionWrites++;
        assert.deepEqual(Object.keys(payload.properties).sort(),
          (status==="Not Scheduled"
            ?["Interview Date","Interview Status","Interviewed By","Google Meet URL",
              "Scheduling Reservation ID","Workflow Status"]
            :["Interview Date","Interview Status","Interviewed By","Google Meet URL",
              "Scheduling Reservation ID","Workflow Status"]).sort());
        if(status==="Not Scheduled"){
          assert.equal(payload.properties["Interview Status"].select.name,"Scheduled");
          status="Scheduled";reservationId=reservation;
        }else{
          assert.equal(payload.properties["Interview Status"].select.name,"Not Scheduled");
          status="Not Scheduled";reservationId="";
        }
      }
      return response({id:pageId,archived:false,in_trash:false,
        parent:{type:"database_id",database_id:"03192649741442fe86acdddcc7320798"},
        properties:props});
    }
    if(url.endsWith("/freeBusy")){
      assert.equal(method,"POST");
      assert.deepEqual(JSON.parse(init.body).items,[{id:"interviews@campus2care.org"}]);
      return response({calendars:{"interviews@campus2care.org":{busy:[]}}});
    }
    if(url.includes("calendar/v3/calendars/primary/events")){
      if(method==="GET")return event?response(event):response({error:"not found"},404);
      if(method==="POST"){
        assert.match(url,/sendUpdates=none/);
        const payload=JSON.parse(init.body);
        assert.equal(payload.summary,"[SYSTEM TEST] Campus2Care interview booking canary");
        assert.deepEqual(payload.attendees,[{email:recipient}]);
        assert.equal(payload.start.dateTime,"2026-11-09T19:00:00.000Z");
        assert.match(payload.id,/^[a-v0-9]{5,100}$/);
        event={id:payload.id,extendedProperties:payload.extendedProperties,
          hangoutLink:meet,status:"confirmed"};
        return response(event,201);
      }
      if(method==="DELETE"){
        assert.match(url,/sendUpdates=none/);event=null;
        return new Response(null,{status:204});
      }
    }
    if(url.includes("gmail/v1/users/me/messages/send")){
      assert.equal(method,"POST");
      assert.equal(sent,0,"No duplicate provider confirmation email allowed");
      sent++;
      const raw=JSON.parse(init.body).raw;
      const decoded=Buffer.from(raw,"base64url").toString("utf8");
      assert.match(decoded,/To: contact\+interview-canary-bu@campus2care\.org/);
      assert.doesNotMatch(decoded,/To: .*@(bu\.edu|bc\.edu)/);
      return response({id:"gmail_canary_message_1"});
    }
    throw Error("unexpected remote URL "+url);
  }
  const service=loadInterviewModule("interview-booking-provider-canary",{
    "./interview-google-provider-auth":{
      googleProviderAccessToken:async()=>"test_only_oauth_token",
    },
    "./interview-email":{
      renderInterviewMessage:()=>
        ({subject:"Interview confirmed",text:"[SYSTEM TEST]",html:"<p>[SYSTEM TEST]</p>"}),
    },
    "./interview-production-verification-gate":{
      productionVerificationCanaryConfig:()=>({databaseUrl:"fake-url"}),
      productionVerificationCanaryDatabase:()=>db,
      assertProductionVerificationIdentity:(campus,email,pageIdArg)=>{
        assert.equal(campus,"BU");assert.equal(email,recipient);assert.equal(pageIdArg,pageId);
        return {campus,email,pageId:pageIdArg};
      },
    },
    "./interview-production-notion":{verifyLiveCanaryApplicant:async()=>({})},
    "./interview-notion-contract":{
      assertCampusPipelineParent:()=>{},
      confirmedInterviewNotionProperties:()=>({
        "Workflow Status":{select:{name:"Interview Scheduled"}},
        "Interview Date":{date:{start:"2026-11-09T19:00:00.000Z"}},
        "Interview Status":{select:{name:"Scheduled"}},
        "Interviewed By":{rich_text:[{text:{content:"interviews@campus2care.org"}}]},
        "Scheduling Reservation ID":{rich_text:[{text:{content:reservation}}]},
        "Google Meet URL":{url:meet},
      }),
    },
  });
  return {service,transport,requests,stats:()=>({ledger,event,status,reservationId,sent,notionWrites})};
}
test("real-provider-shaped single-slot canary and cleanup contact only test alias, never approved slots",async()=>{
  const f=fixture(),before=globalThis.fetch;
  globalThis.fetch=f.transport;
  try{
    const result=await f.service.runBookingProviderCanary();
    assert.equal(result.state,"complete");
    assert.equal(result.gmailAccepted,true);
    assert.equal(result.calendarEventCreated,true);
    assert.equal(result.notionSynchronized,true);
    assert.equal(f.stats().sent,1);
    assert.equal(f.stats().notionWrites,1);
    await assert.rejects(f.service.runBookingProviderCanary(),/test_record_not_clean|already_attempted/);
    assert.equal(f.stats().sent,1);
    const cleanup=await f.service.cleanupBookingProviderCanary();
    assert.equal(cleanup.state,"cleaned");
    assert.equal(f.stats().event,null);
    assert.equal(f.stats().status,"Not Scheduled");
    assert.equal(f.stats().reservationId,"");
    assert.equal(f.stats().sent,1);
    assert.equal(f.stats().notionWrites,2);
    assert.equal(f.requests.filter(x=>x.url.includes("/messages/send")).length,1);
    assert.equal(f.requests.filter(x=>x.method==="DELETE").length,1);
  }finally{globalThis.fetch=before;}
});
