import test from "node:test";
import assert from "node:assert/strict";
import { loadInterviewModule } from "./interview-test-loader.mjs";

const lead="11111111-1111-1111-1111-111111111111";
const start="2026-11-02T18:00:00.000Z";
const page="a".repeat(32);
const email="contact+interview-canary-bu@campus2care.org";
const inviteId="33333333-3333-3333-3333-333333333333";
const eventId="c2c"+ "a".repeat(50);
const meetUrl="https://meet.google.com/abc-defg-hij";
const participants=[
  {id:lead,email:"president@campus2care.org",name:"Lead",role:"lead",available:true},
  {id:"22222222-2222-2222-2222-222222222222",email:"test-shadow@campus2care.org",name:"Shadow",role:"shadow",available:true},
];
const team={id:"44444444-4444-4444-4444-444444444444",revision:"1",
  campus:"BU",leadId:lead,startsAt:start,approvedBy:"president@campus2care.org",participants};

function fixture(){
  const reservation={id:null,status:null,calendar_id:null,calendar_event_id:null,meet_url:null,
    calendar_operation_key:null,starts_at:new Date(start),
    ends_at:new Date(Date.parse(start)+20*60_000),
    campus:"BU",notion_page_id:page,interviewer_id:lead,email,
    interviewer_email:participants[0].email};
  const messages=new Map(),outbox=new Map(),sqlHistory=[];
  let calendarWrites=0,notionWrites=0,gmailWrites=0;
  const invitation={id:inviteId,campus:"BU",notion_page_id:page,
    recipient_hmac:"f".repeat(64),email};
  const sql=async(strings,...args)=>{
    const text=strings.join("?");
    sqlHistory.push({text,args});
    if(text.includes("FROM interview.invitation i"))return [invitation];
    if(text.includes("FROM interview.interviewer WHERE"))return [{
      id:lead,active:true,allowed_campuses:["BU"],weekly_capacity_limit:13,
      workspace_email:participants[0].email}];
    if(text.includes("FROM interview.schedule_slot"))return [{id:team.id}];
    if(text.includes("count(*)::int AS total"))return [{total:0}];
    if(text.includes("INSERT INTO interview.reservation")){
      assert.equal(reservation.id,null,"reservation inserted only once");
      Object.assign(reservation,{id:args[0],status:"calendar_pending"});
      return [];
    }
    if(text.includes("FROM interview.reservation r"))return reservation.id?[{...reservation}]:[];
    if(text.includes("UPDATE interview.reservation")){
      if(text.includes("SET calendar_id=")){
        reservation.calendar_id="interviews@campus2care.org";
        reservation.calendar_event_id=args[0];reservation.calendar_operation_key=args[1];
      }
      if(text.includes("SET meet_url="))reservation.meet_url=args[0];
      if(text.includes("SET status='confirmed'"))reservation.status="confirmed";
      return [{id:reservation.id}];
    }
    if(text.includes("INSERT INTO interview.integration_outbox")){
      const operation=args[0];
      if(!outbox.has(operation)){
        const provider = text.includes("'google_calendar'") ? "google_calendar"
          : text.includes("'notion'") ? "notion" : "gmail";
        const action = text.includes("'create_event'") ? "create_event"
          : text.includes("'sync_interview'") ? "sync_interview" : "send_message";
        const job={id:String(outbox.size+1),operation_key:operation,
          provider,action,object_id:reservation.id,attempts:1};
        outbox.set(operation,job);
      }
      return [];
    }
    if(text.includes("INSERT INTO interview.message")){
      const operation=args[0];
      messages.set(operation,{id:"11111111-2222-3333-4444-555555555555",
        operation_key:operation,recipient_ref:args[1],kind:"confirmation",
        state:"queued",gmail_message_id:null});
      return [];
    }
    if(text.includes("FROM interview.message"))return [messages.get(args[0])].filter(Boolean);
    if(text.includes("UPDATE interview.message SET state='reconcile_required'")){
      const item=[...messages.values()].find(m=>m.id===args[0]);
      if(item?.state!=="queued")return [];
      item.state="reconcile_required";return [{id:item.id}];
    }
    if(text.includes("UPDATE interview.message SET state='accepted'")){
      const item=[...messages.values()].find(m=>m.id===args[1]);
      if(item){item.state="accepted";item.gmail_message_id=args[0];}
      return [];
    }
    throw Error("unexpected DB statement: "+text.slice(0,160));
  };
  sql.begin=async cb=>cb(sql);
  sql.json=value=>value;
  const teamDeps={
    readInterviewTeams:async()=>[team],
    teamForSlot:(xs,id,at,campus)=>xs.find(x=>x.leadId===id&&x.startsAt===at&&x.campus===campus),
    lockInterviewTeamWeeks:async()=>{},
  };
  const booking=loadInterviewModule("interview-production-booking",{
    "./interview-teams":teamDeps,
    "./interview-production-notion":{verifyLiveCanaryApplicant:async()=>({})},
    "./interview-production-db":{productionInterviewDatabase:()=>{throw Error("unexpected real database access");}},
  });
  class ProviderError extends Error {constructor(code,disposition){super(code);this.code=code;this.disposition=disposition;}}
  const worker=loadInterviewModule("interview-production-worker",{
    "./interview-production-canary":{
      productionCanaryConfig:()=>({}),
      assertProductionCanaryIdentity:(campus,address,notionPage)=>{
        assert.equal(campus,"BU");assert.equal(address,email);assert.equal(notionPage,page);},
    },
    "./interview-production-db":{productionInterviewDatabase:()=>{throw Error("unexpected real DB access");}},
    "./interview-production-notion":{verifyLiveCanaryApplicant:async()=>({})},
    "./interview-teams":teamDeps,
    "./interview-production-providers":{ProductionProviderError:ProviderError},
  });
  return {booking,worker,reservation,messages,outbox,sql,sqlHistory,
    input:{invitationToken:"a".repeat(43),interviewerId:lead,startsAt:start},
    deps:{database:sql,now:Date.parse("2026-10-29T12:00:00Z"),
      verifyApplicant:async()=>({}),checkCalendars:async()=>{}},
    getWrites:()=>({calendarWrites,notionWrites,gmailWrites}),
    process:async()=>{
      const cal=outbox.get("interview-calendar:create:"+reservation.id);
      assert.ok(cal,"Calendar outbox job generated by booking");
      assert.equal((await worker.handleProductionCanaryJob(cal,{
        db:sql,verifyApplicant:async()=>({}),
        createEvent:async payload=>{
          calendarWrites++;
          assert.equal(payload.applicantEmail,email);
          assert.equal(payload.participants.length,2);
          assert.deepEqual(payload.participants.map(p=>p.role),["lead","shadow"]);
          return {id:eventId,status:"confirmed",meetUrl};
        },
      })).state,"done");
      assert.equal(reservation.meet_url,meetUrl);
      const not=outbox.get("interview-notion:confirmed:"+reservation.id);
      assert.ok(not,"Notion job generated by Calendar");
      assert.equal((await worker.handleProductionCanaryJob(not,{
        db:sql,syncNotion:async payload=>{
          notionWrites++;assert.equal(payload.pageId,page);assert.equal(payload.meetUrl,meetUrl);
          assert.equal(payload.reservationId,reservation.id);return "written";
        },
      })).state,"done");
      assert.equal(reservation.status,"confirmed");
      const mail=outbox.get("interview-mail:confirmation:"+reservation.id);
      assert.ok(mail,"Gmail job generated by Notion");
      assert.equal((await worker.handleProductionCanaryJob(mail,{
        db:sql,sendGmail:async payload=>{
          gmailWrites++;assert.equal(payload.email,email);assert.equal(payload.meetUrl,meetUrl);
          return "gmail_canary_confirmation_1";
        },
      })).state,"done");
      assert.equal(messages.get(mail.operation_key)?.state,"accepted");
      assert.equal(messages.get(mail.operation_key)?.gmail_message_id,"gmail_canary_confirmation_1");
      return {cal,not,mail};
    },
  };
}
function setCanaryEnv(){
 Object.assign(process.env,{
   VERCEL_ENV:"production",INTERVIEW_DATA_ENV:"production",
   INTERVIEW_PRODUCTION_ENABLED:"true",INTERVIEW_BOOKING_ENABLED:"true",
   INTERVIEW_PRODUCTION_CANARY_ENABLED:"true",INTERVIEW_PRODUCTION_WORKER_ADAPTER_READY:"true",
   INTERVIEW_OUTREACH_ENABLED:"false",INTERVIEW_PRODUCTION_ENROLLMENT_ENABLED:"false",
   INTERVIEW_CALENDAR_WRITES_ENABLED:"true",INTERVIEW_GMAIL_SENDS_ENABLED:"true",
   INTERVIEW_NOTION_WRITES_ENABLED:"true",INTERVIEW_OUTBOX_WORKER_ENABLED:"true",
   INTERVIEW_DATABASE_URL:"postgres://test:secret@ep-prod.us-east-1.aws.neon.tech/c2c?sslmode=require",
   INTERVIEW_DATABASE_HOST:"ep-prod.us-east-1.aws.neon.tech",
   INTERVIEW_PRODUCTION_CANARY_EMAILS:email,
   INTERVIEW_PRODUCTION_CANARY_PAGE_IDS:page,
 });
}
test("actual production reservation and outbox worker complete ordered Calendar->Notion->Gmail journey (all providers mocked)",async()=>{
  setCanaryEnv();
  const f=fixture();
  const held=await f.booking.createProductionCanaryHold(f.input,f.deps);
  assert.equal(held.status,"calendar_pending");
  assert.equal(f.outbox.size,1);
  const jobs=await f.process();
  assert.equal(f.outbox.size,3);
  assert.deepEqual(f.getWrites(),{calendarWrites:1,notionWrites:1,gmailWrites:1});
  assert.equal(f.reservation.status,"confirmed");
  assert.equal((await f.worker.handleProductionCanaryJob(jobs.mail,{db:f.sql,sendGmail:async()=>{throw Error("duplicate mail");}})).state,"done");
  assert.deepEqual(f.getWrites(),{calendarWrites:1,notionWrites:1,gmailWrites:1});
});
