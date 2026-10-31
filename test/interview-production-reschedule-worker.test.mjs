import test from "node:test";
import assert from "node:assert/strict";
import {loadInterviewModule} from "./interview-test-loader.mjs";
const requestId="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",reservationId="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const members=[{id:"11111111-1111-1111-1111-111111111111",email:"cori@campus2care.org",role:"lead",available:true},
 {id:"22222222-2222-2222-2222-222222222222",email:"sarah@campus2care.org",role:"shadow",available:true}];
const team={revision:"1",approvedBy:"president@campus2care.org",participants:members};
const service=loadInterviewModule("interview-production-reschedule-worker",{
 "./interview-production-canary":{assertProductionCanaryIdentity:()=>true},
 "./interview-teams":{readInterviewTeams:async()=>[team],teamForSlot:()=>team,lockInterviewTeamWeeks:async()=>{}},
});
function fixture({pendingMeet=false,notionError=false,cancelError=false,completed=false}={}){
 const events=[];
 const row={id:requestId,reservation_id:reservationId,interviewer_id:members[0].id,
  starts_at:new Date("2026-11-02T18:20:00Z"),ends_at:new Date("2026-11-02T18:40:00Z"),
  state:completed?"completed":"pending",original_calendar_key:"interview-calendar:create:"+reservationId,
  campus:"BU",notion_page_id:"c".repeat(32),email:"test@campus2care.org",status:"confirmed",
  calendar_operation_key:completed?"interview-calendar:reschedule:"+requestId:"interview-calendar:create:"+reservationId,
  current_start:new Date(completed?"2026-11-02T18:20:00Z":"2026-11-02T18:00:00Z"),
  current_meet:"https://meet.google.com/abc-defg-hij",current_interviewer:members[0].email};
 const db=async(strings)=>{
  const sql=strings.join("?");
  if(sql.includes("FROM interview.reschedule_request x"))return [{...row}];
  if(sql.includes("FROM interview.interviewer WHERE"))return [{active:true,allowed_campuses:["BU"]}];
  if(sql.includes("SELECT status,calendar_operation_key"))return [{status:row.status,calendar_operation_key:row.calendar_operation_key}];
  if(sql.includes("SELECT state FROM interview.reschedule_request"))return [{state:row.state}];
  if(sql.includes("SELECT interviewer_id FROM interview.slot_claim"))return members.map(m=>({interviewer_id:m.id}));
  if(sql.includes("UPDATE interview.reservation")){events.push("switch");row.calendar_operation_key="interview-calendar:reschedule:"+requestId;}
  if(sql.includes("UPDATE interview.reschedule_request"))row.state="completed";
  if(sql.includes("DELETE FROM interview.slot_claim"))events.push(sql.includes("retired")?"release-old":"release-new");
  if(sql.includes("INSERT INTO interview.message"))events.push("queue-mail");
  return [];
 };
 db.begin=async callback=>callback(db);
 const deps={verifyApplicant:async()=>{},createEvent:async()=>{events.push("create");return {id:"event",status:"confirmed",meetUrl:pendingMeet?null:"https://meet.google.com/new-link-abc"};},
  syncNotion:async()=>{events.push("notion");if(notionError)throw Error("notion unavailable");},
  cancelEvent:async()=>{events.push("cancel-old");if(cancelError)throw Error("cancel unknown");}};
 const job={id:requestId,object_id:requestId,operation_key:"interview-reschedule:create:"+requestId,provider:"google_calendar",action:"reschedule_create",attempts:1};
 return {db,deps,events,job};
}
test("replacement switches only after Meet and Notion, then cancels the original before email",async()=>{
 const f=fixture();assert.equal((await service.handleProductionRescheduleJob(f.job,f.db,f.deps)).state,"done");
 for(const [before,after] of [["create","notion"],["notion","switch"],["switch","cancel-old"],["cancel-old","queue-mail"]])
  assert.ok(f.events.indexOf(before)<f.events.indexOf(after),before+" before "+after);
});
test("pending Meet or failed Notion preserves the original; failed cleanup retains its claims",async()=>{
 const pending=fixture({pendingMeet:true});assert.equal((await service.handleProductionRescheduleJob(pending.job,pending.db,pending.deps)).state,"retry");assert.deepEqual(pending.events,["create"]);
 const notion=fixture({notionError:true});await assert.rejects(service.handleProductionRescheduleJob(notion.job,notion.db,notion.deps));assert.equal(notion.events.includes("switch"),false);
 const cleanup=fixture({cancelError:true});await assert.rejects(service.handleProductionRescheduleJob(cleanup.job,cleanup.db,cleanup.deps));assert.equal(cleanup.events.includes("queue-mail"),false);
});
test("crash recovery after switching does not create or synchronize a second replacement",async()=>{
 const f=fixture({completed:true});assert.equal((await service.handleProductionRescheduleJob(f.job,f.db,f.deps)).state,"done");
 assert.equal(f.events.includes("create"),false);assert.equal(f.events.includes("notion"),false);assert.ok(f.events.includes("cancel-old"));
});
