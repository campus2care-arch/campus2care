import test from "node:test";
import assert from "node:assert/strict";
import { loadInterviewModule } from "./interview-test-loader.mjs";

const saved = [];
const conflictWeek="2026-11-02";
const route=loadInterviewModule("../app/api/interview/staff/availability/route",{
  "next/server":{NextResponse:{json:(body,options={})=>({body,status:options.status??200})}},
  "../../../../../lib/interview-auth":{
    interviewBaseOrigin:()=> "https://www.campus2care.org",
    staffFromRequest:req=>req.actor??null,
  },
  "../../../../../lib/interview-store":{
    permittedWeek:week=>["2026-11-02","2026-11-09"].includes(week),
    staffStoreToken:()=>({}),
  },
  "../../../../../lib/interview-week-choice":{
    needsCurrentWeekAcknowledgement:week=>week===conflictWeek,
  },
  "../../../../../lib/interview-week-db":{
    isPostgresInterviewWeeksEnabled:()=>true,
    saveAuthoritativeInterviewWeek:async(email,week,record,revision)=>{
      saved.push({email,week,record,revision});
      if(email==="founder-managed@campus2care.org")throw new Error("founder_managed_week");
      return {revision:"db:2",conflictedBookings:week===conflictWeek?2:0};
    },
    InterviewWeekConflict:class extends Error{},
  },
  "../../../../../lib/interview-staff-db":{
    productionStaffEnabled:()=>true,
    rosterMember:async()=>true,
  },
});
const make=(email,body,origin="https://www.campus2care.org")=>({
  actor:email?{email,role:"ea"}:null,
  headers:new Headers({origin,"content-type":"application/json"}),
  text:async()=>JSON.stringify(body),
});
const input={action:"confirm",weekStart:conflictWeek,status:"confirmed",
  revision:"db:1",recurringWindows:[{weekday:1,windows:[{startMinute:540,endMinute:600}]}],overrides:[]};

test("current-week changes fail closed without explicit acknowledgement",async()=>{
  saved.length=0;
  const result=await route.POST(make("ea@campus2care.org",input));
  assert.equal(result.status,409);
  assert.equal(result.body.error,"current_week_acknowledgement_required");
  assert.equal(saved.length,0,"no database write on rejected current-week request");
});

test("explicitly acknowledged current-week change returns booking conflicts for leadership review",async()=>{
  saved.length=0;
  const result=await route.POST(make("ea@campus2care.org",{...input,acknowledgeCurrentWeek:true}));
  assert.equal(result.status,200);
  assert.equal(result.body.conflictedBookings,2);
  assert.deepEqual(saved.map(x=>x.week),[conflictWeek]);
});

test("next-week availability does not require a current-week override and writes only that week",async()=>{
  saved.length=0;
  const result=await route.POST(make("ea@campus2care.org",
    {...input,weekStart:"2026-11-09",acknowledgeCurrentWeek:false}));
  assert.equal(result.status,200);
  assert.equal(result.body.conflictedBookings,0);
  assert.deepEqual(saved.map(x=>x.week),["2026-11-09"]);
});

test("founder-managed weeks stay protected even with acknowledgement",async()=>{
  saved.length=0;
  const result=await route.POST(make("founder-managed@campus2care.org",
    {...input,acknowledgeCurrentWeek:true}));
  assert.equal(result.status,409);
  assert.equal(result.body.error,"founder_managed_week");
});

test("a blank confirmed or template save is rejected and an explicit unavailable week is kept",async()=>{
  saved.length=0;
  const empty={...input,weekStart:"2026-11-09",recurringWindows:[],overrides:[],acknowledgeCurrentWeek:false};
  const confirmed=await route.POST(make("ea@campus2care.org",empty));
  assert.equal(confirmed.status,400);
  assert.equal(confirmed.body.error,"empty_availability_windows");
  const template=await route.POST(make("ea@campus2care.org",{...empty,action:"template"}));
  assert.equal(template.status,400);
  assert.equal(template.body.error,"empty_availability_windows");
  const optedOut=await route.POST(make("ea@campus2care.org",{...empty,status:"unavailable"}));
  assert.equal(optedOut.status,200);
  assert.equal(saved.length,1);
  assert.equal(saved[0].record.status,"unavailable");
  assert.deepEqual(saved.map(entry=>entry.week),["2026-11-09"]);
});

test("unauthenticated or wrong-origin requests cannot change availability",async()=>{
  saved.length=0;
  assert.equal((await route.POST(make(null,{...input,acknowledgeCurrentWeek:true}))).status,401);
  assert.equal((await route.POST(make("ea@campus2care.org",
    {...input,acknowledgeCurrentWeek:true},"https://evil.invalid"))).status,403);
  assert.equal(saved.length,0);
});
