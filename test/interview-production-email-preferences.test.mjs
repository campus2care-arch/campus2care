import test from "node:test";
import assert from "node:assert/strict";
import {loadInterviewModule} from "./interview-test-loader.mjs";

const token="A".repeat(43), invite="11111111-1111-1111-1111-111111111111";
const start=new Date("2026-11-10T20:20:00Z");
const lead="22222222-2222-2222-2222-222222222222";
const team={id:"44444444-4444-4444-4444-444444444444",leadId:lead,
  campus:"BC",approvedBy:"president@campus2care.org",startsAt:start.toISOString(),
  participants:[
    {id:lead,role:"lead",email:"president@campus2care.org",name:"Andrew",available:true},
    {id:"33333333-3333-3333-3333-333333333333",role:"shadow",
      email:"ryan.daves@campus2care.org",name:"Ryan",available:true},
  ]};
const service=loadInterviewModule("interview-production-public",{
  "./interview-production-launch":{productionRealConfig:()=>({})},
  "./interview-production-db":{productionInterviewDatabase:()=>{throw Error("live database forbidden");}},
  "./interview-teams":{
    readInterviewTeams:async()=>[team],
    teamForSlot:(items,leadId,startsAt,campus)=>
      items.find(x=>x.leadId===leadId&&x.startsAt===startsAt&&x.campus===campus),
    hasRequiredInterviewTeam:(_campus,parts)=>
      parts.filter(x=>x.role==="lead").length===1&&parts.some(x=>x.role==="shadow"),
  },
  "./interview-production-notion":{verifyLiveCanaryApplicant:async()=>({})},
});
function database({verified=true,optedOut=true}={}){
 const queries=[];
 const db=async(parts,...args)=>{
   const sql=parts.join("?");queries.push({sql,args});
   if(sql.includes("FROM interview.invitation i"))return [{
     id:invite,campus:"BC",notion_page_id:"a".repeat(32),email:"volunteer@bc.edu",
     email_verified_at:verified?new Date("2026-11-03T20:00:00Z"):null,
     opted_out_at:optedOut?new Date("2026-11-03T21:00:00Z"):null,
   }];
   if(sql.includes("FROM interview.reservation"))return [];
   if(sql.includes("FROM interview.schedule_slot s JOIN interview.interviewer i"))return [{
     id:team.id,lead_id:lead,starts_at:start,display_name:"Andrew",weekly_capacity_limit:22,
   }];
   if(sql.includes("count(*)::int AS total"))return [{total:0}];
   if(sql.includes("UPDATE interview.applicant_contact")&&sql.includes("SET opted_out_at=NULL"))return [{invitation_id:invite}];
   return [];
 };
 db.begin=fn=>fn(db);
 return {db,queries};
}
test("an opted-out BC applicant can voluntarily view founder-approved interview slots",async()=>{
 const f=database();
 const result=await service.readLiveInterviewSlots(token,undefined,{
   db:f.db,now:new Date("2026-11-03T22:00:00Z"),verify:async()=>({})
 });
 assert.equal(result.length,1);
 assert.equal(result[0].startsAt,start.toISOString());
 assert.ok(f.queries.some(x=>x.sql.includes("FROM interview.schedule_slot")));
});
test("email opt-out is surfaced as a preference without hiding an existing invitation",async()=>{
 const f=database();
 const status=await service.readLiveInterviewStatus(token,{db:f.db});
 assert.equal(status.optedOut,true);
 assert.equal(status.booking,null);
});
test("resume invitation emails requires a verified token and writes an audit record",async()=>{
 const f=database();
 const result=await service.resumeLiveInterviewInvites(token,{db:f.db});
 assert.deepEqual(result,{optedOut:false});
 assert.ok(f.queries.some(x=>x.sql.includes("SET opted_out_at=NULL")));
 assert.ok(f.queries.some(x=>x.sql.includes("resume_interview_invitation_emails")));
 const unverified=database({verified:false});
 await assert.rejects(service.resumeLiveInterviewInvites(token,{db:unverified.db}),
   /invalid_or_unverified_invitation/);
 assert.ok(!unverified.queries.some(x=>x.sql.includes("UPDATE interview.applicant_contact")));
});
