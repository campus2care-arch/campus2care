import test from "node:test";
import assert from "node:assert/strict";
import { loadInterviewModule } from "./interview-test-loader.mjs";

class ProviderError extends Error {
  constructor(code,disposition){super(code);this.code=code;this.disposition=disposition;}
}
const members=[
 {id:"11111111-1111-1111-1111-111111111111",email:"cori@campus2care.org",role:"lead",available:true},
 {id:"22222222-2222-2222-2222-222222222222",email:"sarah@campus2care.org",role:"shadow",available:true},
];
const row={
 id:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",campus:"BU",notion_page_id:"b".repeat(32),
 interviewer_id:members[0].id,starts_at:new Date("2026-11-02T18:00:00Z"),
 ends_at:new Date("2026-11-02T18:20:00Z"),status:"calendar_pending",
 calendar_id:null,calendar_event_id:null,meet_url:null,
 email:"test@campus2care.org",interviewer_email:"cori@campus2care.org",
};
const mockTeam={id:"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",startsAt:row.starts_at.toISOString(),
 campus:"BU",leadId:members[0].id,approvedBy:"president@campus2care.org",
 participants:members};
const module=loadInterviewModule("interview-production-worker",{
 "./interview-production-canary":{
   productionCanaryConfig:()=>({}),
   assertProductionCanaryIdentity:()=>true,
 },
 "./interview-production-db":{productionInterviewDatabase:()=>{throw Error("production DB access in test");}},
 "./interview-teams":{
   readInterviewTeams:async()=>[mockTeam],
   teamForSlot:(all,lead,start,campus)=>all.find(x=>x.leadId===lead&&x.startsAt===start&&x.campus===campus),
 },
 "./interview-production-providers":{ProductionProviderError:ProviderError},
});
const id=row.id;
const calendar={id:"c2c"+"a".repeat(64),status:"confirmed",meetUrl:"https://meet.google.com/abc-defg-hij"};
const jobs={
 calendar:{id:"f".repeat(8)+"-1111-2222-3333-"+ "f".repeat(12),operation_key:"interview-calendar:create:"+id,provider:"google_calendar",action:"create_event",object_id:id,attempts:1},
 notion:{id:"f".repeat(8)+"-1111-2222-3333-"+ "e".repeat(12),operation_key:"interview-notion:confirmed:"+id,provider:"notion",action:"sync_interview",object_id:id,attempts:1},
 gmail:{id:"f".repeat(8)+"-1111-2222-3333-"+ "d".repeat(12),operation_key:"interview-mail:confirmation:"+id,provider:"gmail",action:"send_message",object_id:id,attempts:1},
};
function fakeDB({status=row.status,meetUrl=row.meet_url,messageState="queued"}={}){
 const calls=[];let reservation={...row,status,meet_url:meetUrl,calendar_event_id:meetUrl?calendar.id:null};
 const sql=async(strings,...args)=>{
   const text=strings.join("?");
   calls.push({text,args});
   if(text.includes("FROM interview.reservation r"))return [reservation];
   if(text.includes("UPDATE interview.reservation")&&text.includes("calendar_id"))return [{id}];
   if(text.includes("UPDATE interview.reservation")&&text.includes("meet_url")){
      reservation.meet_url=calendar.meetUrl;return [{id}];
   }
   if(text.includes("UPDATE interview.reservation")&&text.includes("status='confirmed'")){
     reservation.status="confirmed";return [{id}];
   }
   if(text.includes("FROM interview.message"))return [{
     id:"cccccccc-cccc-cccc-cccc-cccccccccccc",recipient_ref:row.email,kind:"confirmation",
     state:messageState,gmail_message_id:messageState==="accepted"?"sent123":null,
   }];
   if(text.includes("UPDATE interview.message SET state='reconcile_required'"))return [{id}];
   if(text.includes("UPDATE interview.message SET state='accepted'"))return [];
   return [];
 };
 sql.begin=async cb=>cb(sql);
 return {db:sql,calls};
}
test("only exact Calendar, Notion and Gmail confirmation jobs can run",()=>{
 for(const job of Object.values(jobs))assert.equal(module.isCanaryJob(job),true);
 assert.equal(module.isCanaryJob({...jobs.gmail,operation_key:"interview-mail:invitation:"+id}),false);
 assert.equal(module.isCanaryJob({...jobs.calendar,action:"cancel_event"}),false);
});
test("Calendar worker inserts Notion job only after unique Meet link is ready",async()=>{
 const f=fakeDB();const result=await module.handleProductionCanaryJob(jobs.calendar,{
   db:f.db,createEvent:async input=>{
     assert.equal(input.applicantEmail,row.email);
     assert.equal(input.participants.length,2);
     return calendar;
   },
 });
 assert.equal(result.state,"done");
 assert.ok(f.calls.some(x=>x.text.includes("UPDATE interview.reservation")&&x.text.includes("meet_url")));
 assert.equal(f.calls.filter(x=>x.text.includes("INSERT INTO interview.integration_outbox")).length,1);
});
test("pending Google Meet details retry without creating Notion or Gmail jobs",async()=>{
 const f=fakeDB();
 const result=await module.handleProductionCanaryJob(jobs.calendar,{
   db:f.db,createEvent:async()=>({...calendar,meetUrl:null}),
 });
 assert.equal(result.state,"retry");
 assert.equal(f.calls.some(x=>x.text.includes("INSERT INTO interview.integration_outbox")),false);
});
test("Notion is synchronized before the worker can queue confirmation email",async()=>{
 const f=fakeDB({meetUrl:calendar.meetUrl});let synced=0;
 const result=await module.handleProductionCanaryJob(jobs.notion,{
   db:f.db,syncNotion:async input=>{synced++;assert.equal(input.pageId,row.notion_page_id);return "written";},
 });
 assert.equal(result.state,"done");
 assert.equal(synced,1);
 assert.ok(f.calls.some(x=>x.text.includes("INSERT INTO interview.message")));
 assert.ok(f.calls.some(x=>x.text.includes("INSERT INTO interview.integration_outbox")));
});
test("Notion error prevents Gmail job creation and is quarantined",async()=>{
 const f=fakeDB({meetUrl:calendar.meetUrl});
 const result=await module.handleProductionCanaryJob(jobs.notion,{
   db:f.db,syncNotion:async()=>{throw new ProviderError("notion_unknown","reconcile_required");},
 });
 assert.equal(result.state,"reconcile_required");
 assert.equal(f.calls.some(x=>x.text.includes("INSERT INTO interview.message")),false);
});
test("Gmail is sent once after confirmed Notion sync, and previous acceptance is not resent",async()=>{
 const f=fakeDB({status:"confirmed",meetUrl:calendar.meetUrl});let sent=0;
 const result=await module.handleProductionCanaryJob(jobs.gmail,{
   db:f.db,sendGmail:async()=>{sent++;return "sent123";},
 });
 assert.equal(result.state,"done");assert.equal(sent,1);
 assert.ok(f.calls.some(x=>x.text.includes("UPDATE interview.message SET state='reconcile_required'")));
 const accepted=fakeDB({status:"confirmed",meetUrl:calendar.meetUrl,messageState:"accepted"});
 const outcome=await module.handleProductionCanaryJob(jobs.gmail,{
   db:accepted.db,sendGmail:async()=>{throw Error("duplicate send");},
 });
 assert.equal(outcome.state,"done");
});
test("Gmail ambiguous outcome remains reconciliation-required",async()=>{
 const f=fakeDB({status:"confirmed",meetUrl:calendar.meetUrl});
 const result=await module.handleProductionCanaryJob(jobs.gmail,{
   db:f.db,sendGmail:async()=>{throw new ProviderError("gmail_timeout","reconcile_required");},
 });
 assert.equal(result.state,"reconcile_required");
});
