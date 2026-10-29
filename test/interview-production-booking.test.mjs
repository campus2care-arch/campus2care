import test from "node:test";
import assert from "node:assert/strict";
import { loadInterviewModule } from "./interview-test-loader.mjs";

const leadId="11111111-1111-1111-1111-111111111111";
const instant="2026-11-02T18:00:00.000Z";
const page="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const attendee=[
 {id:leadId,email:"cori.miller@campus2care.org",name:"Cori",role:"lead",available:true},
 {id:"22222222-2222-2222-2222-222222222222",email:"sarah@campus2care.org",name:"Sarah",role:"shadow",available:true},
];
const team={
 id:"44444444-4444-4444-4444-444444444444",revision:"1",
 approvedBy:"president@campus2care.org",campus:"BU",
 leadId,startsAt:instant,participants:attendee,
};
const service=loadInterviewModule("interview-production-booking",{
 "./interview-teams":{
   readInterviewTeams:async()=>[team],
   teamForSlot:(all,lead,start,campus)=>all.find(x=>x.leadId===lead&&x.startsAt===start&&x.campus===campus),
   lockInterviewTeamWeeks:async()=>{},
 },
 "./interview-production-notion":{verifyLiveCanaryApplicant:async()=>({})},
 "./interview-production-db":{productionInterviewDatabase:()=>{throw Error("real DB must not be touched");}},
});
function setEnvironment(){
 Object.assign(process.env,{
   VERCEL_ENV:"production",INTERVIEW_DATA_ENV:"production",
   INTERVIEW_PRODUCTION_ENABLED:"true",INTERVIEW_BOOKING_ENABLED:"true",
   INTERVIEW_PRODUCTION_CANARY_ENABLED:"true",INTERVIEW_PRODUCTION_WORKER_ADAPTER_READY:"true",
   INTERVIEW_OUTREACH_ENABLED:"false",INTERVIEW_PRODUCTION_ENROLLMENT_ENABLED:"false",
   INTERVIEW_CALENDAR_WRITES_ENABLED:"true",INTERVIEW_GMAIL_SENDS_ENABLED:"true",
   INTERVIEW_NOTION_WRITES_ENABLED:"true",INTERVIEW_OUTBOX_WORKER_ENABLED:"true",
   INTERVIEW_DATABASE_URL:"postgres://test:secret@ep-prod.us-east-1.aws.neon.tech/c2c?sslmode=require",
   INTERVIEW_DATABASE_HOST:"ep-prod.us-east-1.aws.neon.tech",
   INTERVIEW_PRODUCTION_CANARY_EMAILS:"test@campus2care.org",
   INTERVIEW_PRODUCTION_CANARY_PAGE_IDS:page,
 });
}
function fixture({email="test@campus2care.org",capacity=0,conflict=false,calendarError=false,notionError=false}={}){
 setEnvironment();
 const queries=[],calendar=[];
 const sql=async(strings,...args)=>{
   const statement=strings.join("?");
   queries.push({statement,args});
   if(statement.includes("FROM interview.invitation i")){
     return [{id:"33333333-3333-3333-3333-333333333333",campus:"BU",
       notion_page_id:page,recipient_hmac:"f".repeat(64),email}];
   }
   if(statement.includes("FROM interview.interviewer WHERE"))return [{
     id:leadId,active:true,allowed_campuses:["BU"],weekly_capacity_limit:13,
     workspace_email:"cori.miller@campus2care.org"
   }];
   if(statement.includes("FROM interview.schedule_slot"))return [{id:team.id}];
   if(statement.includes("count(*)::int AS total"))return [{total:capacity}];
   if(statement.includes("INSERT INTO interview.reservation")&&conflict) {
     throw Object.assign(Error("overlap"),{code:"23P01"});
   }
   return [];
 };
 sql.begin=async(callback)=>callback(sql);
 const deps={
  database:sql,now:Date.parse("2026-10-29T12:00:00Z"),
  verifyApplicant:async()=>{if(notionError)throw Error("notion_ineligible");return {};},
  checkCalendars:async(people,start,end)=>{calendar.push({people,start,end});if(calendarError)throw Error("calendar_conflict");},
 };
 return {queries,calendar,deps,input:{invitationToken:"a".repeat(43),interviewerId:leadId,startsAt:instant}};
}
test("approved live canary holds exactly one founder slot and queues one Calendar operation",async()=>{
 const f=fixture();const hold=await service.createProductionCanaryHold(f.input,f.deps);
 assert.equal(hold.status,"calendar_pending");
 assert.equal(hold.startsAt,instant);
 assert.equal(f.calendar.length,1);
 assert.equal(f.calendar[0].people.length,2);
 assert.equal(f.calendar[0].end,"2026-11-02T18:20:00.000Z");
 assert.equal(f.queries.filter(q=>q.statement.includes("INSERT INTO interview.reservation")).length,1);
 assert.equal(f.queries.filter(q=>q.statement.includes("INSERT INTO interview.integration_outbox")).length,1);
 assert.ok(f.queries.some(q=>q.statement.includes("FOR UPDATE OF i,c")));
});
test("wrong identity never creates a booking",async()=>{
 const f=fixture({email:"other@campus2care.org"});
 await assert.rejects(service.createProductionCanaryHold(f.input,f.deps),/canary_identity_denied/);
 assert.equal(f.queries.some(q=>q.statement.includes("INSERT INTO interview.reservation")),false);
});
test("Notion or Calendar rejection fails before reservation starts",async()=>{
 for(const opts of [{notionError:true},{calendarError:true}]){
  const f=fixture(opts);
  await assert.rejects(service.createProductionCanaryHold(f.input,f.deps));
  assert.equal(f.queries.some(q=>q.statement.includes("INSERT INTO interview.reservation")),false);
 }
});
test("weekly capacity and simultaneous slot conflicts are enforced",async()=>{
 const full=fixture({capacity:13});
 await assert.rejects(service.createProductionCanaryHold(full.input,full.deps),/weekly_capacity_reached/);
 const busy=fixture({conflict:true});
 await assert.rejects(service.createProductionCanaryHold(busy.input,busy.deps),/slot_taken/);
 assert.equal(busy.queries.some(q=>q.statement.includes("INSERT INTO interview.integration_outbox")),false);
});
test("a production canary cannot run unless provider worker readiness is explicitly verified",async()=>{
 const f=fixture();
 process.env.INTERVIEW_PRODUCTION_WORKER_ADAPTER_READY="false";
 await assert.rejects(service.createProductionCanaryHold(f.input,f.deps),/canary_disabled/);
 assert.equal(f.queries.length,0);
});
