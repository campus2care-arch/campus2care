import test from "node:test";
import assert from "node:assert/strict";
import {loadInterviewModule} from "./interview-test-loader.mjs";

// Chapter Admin / Interview Team Manager authorization. Real signed sessions and real route
// guards; persistence is replaced by in-memory stubs. Synthetic identities only: no live
// database, Notion, Calendar or email is touched.
process.env.INTERVIEW_AUTH_SECRET="test-only-auth-secret-very-long-not-a-real-password";
process.env.INTERVIEW_BASE_URL="https://www.campus2care.org";
process.env.INTERVIEW_EA_EMAILS="bc.interviewer@campus2care.org";
process.env.INTERVIEW_CHAPTER_ADMINS="ryan.daves@campus2care.org=BC,bu.chapter.admin@campus2care.org=BU";
process.env.VERCEL_ENV="production";

const FOUNDER="president@campus2care.org", RYAN="ryan.daves@campus2care.org";
const BU_ADMIN="bu.chapter.admin@campus2care.org", BC_INTERVIEWER="bc.interviewer@campus2care.org";
const auth=loadInterviewModule("interview-auth");
const access=loadInterviewModule("interview-access");
const reply=(body,status=200)=>({status,body});
// Chapter admins must still be active single-campus leads on the roster (synthetic rows).
const ROSTER={[RYAN]:{id:"ryan-id",email:RYAN,name:"Ryan",campuses:["BC"],teamRole:"lead",leadId:null},
  [BU_ADMIN]:{id:"bu-admin-id",email:BU_ADMIN,name:"BU Admin",campuses:["BU"],teamRole:"lead",leadId:null}};
const rosterMember=async(email)=>ROSTER[email]??null;

function request(path,email,method="GET",body){
  const cookie=email?auth.makeSession(email):null;
  return {
    method,nextUrl:new URL("https://www.campus2care.org"+path),
    cookies:{get(name){return name==="c2c_interview_session"&&cookie?{value:cookie}:undefined;}},
    headers:new Headers(method==="POST"?{"origin":"https://www.campus2care.org","content-type":"application/json"}:{}),
    text:async()=>JSON.stringify(body??{}),
  };
}

test("roles: Ryan is a BC chapter admin, never founder; ordinary staff stay interviewers",()=>{
  const ryan=auth.validateSession(auth.makeSession(RYAN));
  assert.deepEqual(ryan,{email:RYAN,role:"chapter_admin",campus:"BC"});
  assert.deepEqual(auth.validateSession(auth.makeSession(BU_ADMIN)),{email:BU_ADMIN,role:"chapter_admin",campus:"BU"});
  assert.deepEqual(auth.validateSession(auth.makeSession(FOUNDER)),{email:FOUNDER,role:"admin"});
  assert.deepEqual(auth.validateSession(auth.makeSession(BC_INTERVIEWER)),{email:BC_INTERVIEWER,role:"ea"});
  assert.equal(access.isFounder(ryan),false);
  assert.equal(auth.authorizedRole("stranger@campus2care.org"),null);
});

test("registry: the founder can never be configured as a chapter admin; bad entries are ignored",()=>{
  const before=process.env.INTERVIEW_CHAPTER_ADMINS;
  try{
    process.env.INTERVIEW_CHAPTER_ADMINS="president@campus2care.org=BC,typo@campus2care.org=XX,outsider@gmail.com=BC";
    assert.equal(auth.chapterAdminCampus(FOUNDER),null);
    assert.equal(auth.authorizedRole(FOUNDER),"admin");
    assert.equal(auth.chapterAdminCampus("typo@campus2care.org"),null);
    assert.equal(auth.chapterAdminCampus("outsider@gmail.com"),null);
    assert.equal(auth.chapterAdminCampus(RYAN),null,"configured registry replaces the default");
    delete process.env.INTERVIEW_CHAPTER_ADMINS;
    assert.equal(auth.chapterAdminCampus(RYAN),"BC","default keeps today's approved BC lead");
  }finally{process.env.INTERVIEW_CHAPTER_ADMINS=before;}
});

test("scope resolution: founder any campus; chapter admin own campus only; others nothing",()=>{
  const s=(email)=>email?auth.validateSession(auth.makeSession(email)):null;
  assert.equal(access.scopedCampus(s(FOUNDER),null),"ALL");
  assert.equal(access.scopedCampus(s(FOUNDER),"BU"),"BU");
  assert.equal(access.scopedCampus(s(RYAN),null),"BC");
  assert.equal(access.scopedCampus(s(RYAN),"BC"),"BC");
  for(const bad of ["BU","ALL","bc"," BC"]) assert.equal(access.scopedCampus(s(RYAN),bad),null,bad);
  assert.equal(access.scopedCampus(s(BU_ADMIN),"BC"),null);
  assert.equal(access.scopedCampus(s(BC_INTERVIEWER),"BC"),null);
  assert.equal(access.scopedCampus(null,"BC"),null);
});

const dashboard=loadInterviewModule("../app/api/interview/admin/dashboard/route",{
  "../../../../../lib/interview-admin-api":{interviewPrivateReply:reply},
  "../../../../../lib/interview-staff-db":{rosterMember},
  "../../../../../lib/interview-production-applicant-review":{ProductionAudienceReviewError:class extends Error{}},
  "../../../../../lib/interview-founder-dashboard":{
    loadFounderDashboard:async()=>({
      rows:[{key:"BC:a",campus:"BC",name:"Synthetic BC",email:"bc.applicant@example.org"},
        {key:"BU:b",campus:"BU",name:"Synthetic BU",email:"bu.applicant@example.org"}],
      mismatches:[{key:"BU:b",campus:"BU",name:"Synthetic BU",issue:"x"}],
      openSlots:{BU:1,BC:2},remainingCapacity:{BU:1,BC:2}}),
    summarize:(rows,campus)=>({campus,count:rows.filter(r=>campus==="ALL"||r.campus===campus).length}),
  },
});

test("dashboard API: Ryan gets BC applicants only and cannot widen scope by URL",async()=>{
  const ryan=await dashboard.GET(request("/api/interview/admin/dashboard",RYAN));
  assert.equal(ryan.status,200);
  assert.equal(ryan.body.campus,"BC");
  assert.deepEqual(ryan.body.applicants.map(r=>r.campus),["BC"]);
  assert.deepEqual(ryan.body.mismatches,[]);
  for(const q of ["BU","ALL"]) {
    const r=await dashboard.GET(request("/api/interview/admin/dashboard?campus="+q,RYAN));
    assert.equal(r.status,403,q); assert.equal(r.body.applicants,undefined);
  }
  assert.equal((await dashboard.GET(request("/api/interview/admin/dashboard?campus=XX",RYAN))).status,400);
});

test("dashboard API: founder unchanged; BU admin, interviewer and anonymous are bounded",async()=>{
  const founder=await dashboard.GET(request("/api/interview/admin/dashboard",FOUNDER));
  assert.equal(founder.status,200); assert.equal(founder.body.applicants.length,2);
  const bu=await dashboard.GET(request("/api/interview/admin/dashboard?campus=BU",BU_ADMIN));
  assert.deepEqual(bu.body.applicants.map(r=>r.campus),["BU"]);
  assert.equal((await dashboard.GET(request("/api/interview/admin/dashboard?campus=BC",BU_ADMIN))).status,403);
  assert.equal((await dashboard.GET(request("/api/interview/admin/dashboard?campus=BC",BC_INTERVIEWER))).status,403);
  assert.equal((await dashboard.GET(request("/api/interview/admin/dashboard?campus=BC",null))).status,403);
});

class SlotError extends Error{constructor(code){super(code);this.code=code;}}
const slotCalls={reads:[],attendance:[],generated:[],removed:[]};
const slots=loadInterviewModule("../app/api/interview/admin/slots/route",{
  "../../../../../lib/interview-admin-api":{interviewPrivateReply:reply},
  "../../../../../lib/interview-staff-db":{interviewStaffEnabled:()=>true,rosterMember},
  "../../../../../lib/interview-founder-slots":{SlotError,
    readSlotTimetable:async(campus,week)=>{slotCalls.reads.push(campus);return [];},
    recordReservationAttendance:async(id,outcome,actor,db,chapter)=>{slotCalls.attendance.push({actor,chapter:chapter?.campus,leadId:chapter?.leadId});return {recorded:true,outcome};},
    generateSlotsFromAvailability:async()=>{slotCalls.generated.push(1);return {created:1};},
    removeOpenSlot:async()=>{slotCalls.removed.push(1);return {removed:true};}},
});
const W="&week=2026-11-16";
const attendance={action:"attendance",reservationId:"12345678-1234-4234-8234-123456789abc",outcome:"completed"};

test("slots API: Ryan reads BC only and records BC attendance; slot publishing stays founder-only",async()=>{
  slotCalls.reads.length=0;
  assert.equal((await slots.GET(request("/api/interview/admin/slots?campus=BC"+W,RYAN))).status,200);
  assert.equal((await slots.GET(request("/api/interview/admin/slots?campus=BU"+W,RYAN))).status,403);
  assert.equal((await slots.GET(request("/api/interview/admin/slots?campus=ALL"+W,RYAN))).status,403);
  assert.deepEqual(slotCalls.reads,["BC"]);
  const ok=await slots.POST(request("/api/interview/admin/slots",RYAN,"POST",attendance));
  assert.equal(ok.status,200);
  assert.deepEqual(slotCalls.attendance.at(-1),{actor:RYAN,chapter:"BC",leadId:"ryan-id"},"chapter and team scope are passed to the data layer");
  for(const body of [{action:"generate",campus:"BC",week:"2026-11-16"},{action:"remove",slotId:"12345678-1234-4234-8234-123456789abc"}]) {
    assert.equal((await slots.POST(request("/api/interview/admin/slots",RYAN,"POST",body))).status,403,body.action);
  }
  assert.equal(slotCalls.generated.length+slotCalls.removed.length,0);
});

test("slots API: founder keeps every action; interviewer and anonymous are refused",async()=>{
  assert.equal((await slots.GET(request("/api/interview/admin/slots?campus=ALL"+W,FOUNDER))).status,200);
  assert.equal((await slots.POST(request("/api/interview/admin/slots",FOUNDER,"POST",{action:"generate",campus:"BU",week:"2026-11-16"}))).status,200);
  assert.deepEqual((await slots.POST(request("/api/interview/admin/slots",FOUNDER,"POST",attendance))).status,200);
  assert.equal(slotCalls.attendance.at(-1).chapter,undefined,"founder writes are not chapter-limited");
  for(const who of [BC_INTERVIEWER,null]) {
    assert.equal((await slots.GET(request("/api/interview/admin/slots?campus=BC"+W,who))).status,403);
    assert.equal((await slots.POST(request("/api/interview/admin/slots",who,"POST",attendance))).status,403);
  }
});

class RosterError extends Error{constructor(code){super(code);this.code=code;}}
const rosterCalls=[];
const staff=loadInterviewModule("../app/api/interview/admin/staff/route",{
  "../../../../../lib/interview-admin-api":{interviewPrivateReply:reply},
  "../../../../../lib/interview-staff-db":{interviewStaffEnabled:()=>true,rosterMember},
  "../../../../../lib/interview-staff-roster":{RosterError,
    parseRosterLines:(lines,campus)=>[{name:"Synthetic",email:"new.bc@campus2care.org",campus,teamRole:"shadow"}],
    validateRosterInput:(p)=>p,
    readRosterWeek:async(week,campus)=>{rosterCalls.push({op:"read",campus});return [];},
    upsertRoster:async(people,actor,db,chapter)=>{rosterCalls.push({op:"upsert",chapter:chapter?.campus});return {saved:people.length};},
    removeFromRoster:async(email,actor,db,chapter)=>{rosterCalls.push({op:"remove",chapter:chapter?.campus});return {removed:true};},
    markRosterInvited:async(emails,db,chapter)=>{rosterCalls.push({op:"invited",chapter:chapter?.campus});return {marked:0};}},
});

test("roster API: Ryan manages BC interviewers only; every write carries the chapter scope",async()=>{
  rosterCalls.length=0;
  assert.equal((await staff.GET(request("/api/interview/admin/staff?week=2026-11-16&campus=BC",RYAN))).status,200);
  assert.equal((await staff.GET(request("/api/interview/admin/staff?week=2026-11-16&campus=BU",RYAN))).status,403);
  assert.equal((await staff.GET(request("/api/interview/admin/staff?week=2026-11-16&campus=ALL",RYAN))).status,403);
  const crossAdd=await staff.POST(request("/api/interview/admin/staff",RYAN,"POST",{action:"add",campus:"BU",lines:"x"}));
  assert.equal(crossAdd.status,400); assert.equal(crossAdd.body.error,"outside_chapter_scope");
  assert.equal((await staff.POST(request("/api/interview/admin/staff",RYAN,"POST",{action:"add",campus:"BC",lines:"x"}))).status,200);
  await staff.POST(request("/api/interview/admin/staff",RYAN,"POST",{action:"remove",email:"someone@campus2care.org"}));
  await staff.POST(request("/api/interview/admin/staff",RYAN,"POST",{action:"mark_invited",emails:["a@campus2care.org"]}));
  assert.deepEqual(rosterCalls.filter(c=>c.op!=="read").map(c=>c.chapter),["BC","BC","BC"]);
  assert.deepEqual(rosterCalls.filter(c=>c.op==="read").map(c=>c.campus),["BC"]);
});

test("roster API: founder unchanged (unscoped); interviewer and anonymous refused",async()=>{
  rosterCalls.length=0;
  assert.equal((await staff.GET(request("/api/interview/admin/staff?week=2026-11-16&campus=ALL",FOUNDER))).status,200);
  await staff.POST(request("/api/interview/admin/staff",FOUNDER,"POST",{action:"add",campus:"BU",lines:"x"}));
  assert.equal(rosterCalls.at(-1).chapter,undefined);
  for(const who of [BC_INTERVIEWER,null])
    assert.equal((await staff.GET(request("/api/interview/admin/staff?week=2026-11-16&campus=BC",who))).status,403);
});

// Data-layer boundaries: these hold even if a route were ever misconfigured.
const reservationId="12345678-1234-4234-8234-123456789abc";
function attendanceDb(campus,interviewerId="ryan-id"){
  const actions=[];
  const db=async(strings)=>{const sql=strings.join("?");actions.push(sql);
    if(sql.includes("FROM interview.reservation")&&sql.includes("FOR UPDATE"))
      return [{id:reservationId,starts_at:new Date(Date.now()-3600e3),ends_at:new Date(Date.now()-2400e3),status:"confirmed",campus,interviewer_id:interviewerId}];
    return [];};
  db.begin=fn=>fn(db); db.json=v=>v; return {db,actions};
}
const slotLib=loadInterviewModule("interview-founder-slots",{
  "./interview-staff-db":{interviewStaffDatabase:()=>{throw Error("live database forbidden in tests");}},
});

test("attendance data layer: chapter admin can act only on its own campus's reservation",async()=>{
  const own=attendanceDb("BC");
  assert.deepEqual(await slotLib.recordReservationAttendance(reservationId,"completed",RYAN,own.db,{campus:"BC",leadId:"ryan-id"}),{recorded:true,outcome:"completed"});
  assert.equal(own.actions.filter(a=>a.includes("INSERT INTO interview.audit_event")).length,1,"audited");
  const other=attendanceDb("BU");
  await assert.rejects(slotLib.recordReservationAttendance(reservationId,"completed",RYAN,other.db,{campus:"BC",leadId:"ryan-id"}),e=>e.code==="reservation_not_found");
  assert.equal(other.actions.some(a=>a.includes("INSERT INTO interview.audit_event")),false);
  await assert.rejects(slotLib.recordReservationAttendance(reservationId,"completed",RYAN,own.db),e=>e.code==="founder_access_required");
  await assert.rejects(slotLib.generateSlotsFromAvailability("BC","2026-11-16",RYAN,own.db),e=>e.code==="founder_access_required");
});

const rosterLib=loadInterviewModule("interview-staff-roster",{
  "./interview-staff-db":{interviewStaffDatabase:()=>{throw Error("live database forbidden in tests");}},
});
function rosterDb(existing){
  const writes=[];
  const db=async(strings,...values)=>{const sql=strings.join("?");
    if(sql.includes("SELECT lower(workspace_email) AS email, allowed_campuses"))
      return existing.filter(e=>values[0].includes(e.email));
    if(sql.includes("SELECT 1 FROM interview.interviewer")) return existing.filter(e=>e.email===values[0]).map(()=>({}));
    if(sql.includes("SELECT id FROM interview.interviewer")) return [{id:"ryan-id"}];
    if(/INSERT|UPDATE/.test(sql)) writes.push(sql);
    if(sql.includes("RETURNING id")) return [{id:"x"}];
    return [];};
  db.begin=fn=>fn(db); db.json=v=>v; return {db,writes};
}
const person=(email,campus="BC")=>({name:"Synthetic Person",email,campus,teamRole:"shadow",leadEmail:RYAN});
const RYAN_TEAM={campus:"BC",email:RYAN,leadId:"ryan-id"};

test("roster data layer: chapter admin cannot touch other chapters, the founder or chapter admins",async()=>{
  const bc=rosterDb([{email:"bc.member@campus2care.org",allowed_campuses:["BC"],lead_interviewer_id:"ryan-id"}]);
  assert.deepEqual(await rosterLib.upsertRoster([person("bc.member@campus2care.org")],RYAN,bc.db,RYAN_TEAM),{saved:1});
  for(const [label,existing,input] of [
    ["BU member",[{email:"bu.member@campus2care.org",allowed_campuses:["BU"],lead_interviewer_id:"ryan-id"}],person("bu.member@campus2care.org")],
    ["dual-campus member",[{email:"both@campus2care.org",allowed_campuses:["BU","BC"],lead_interviewer_id:"ryan-id"}],person("both@campus2care.org")],
    ["founder",[],person(FOUNDER)],
    ["chapter admin",[],person(BU_ADMIN)],
    ["BU campus input",[],person("new@campus2care.org","BU")],
  ]){
    const f=rosterDb(existing);
    await assert.rejects(rosterLib.upsertRoster([input],RYAN,f.db,RYAN_TEAM),e=>e.code==="outside_chapter_scope",label);
    assert.equal(f.writes.length,0,label+" must write nothing");
  }
  const bu=rosterDb([{email:"bu.member@campus2care.org",allowed_campuses:["BU"],lead_interviewer_id:null}]);
  await assert.rejects(rosterLib.removeFromRoster("bu.member@campus2care.org",RYAN,bu.db,RYAN_TEAM),e=>e.code==="outside_chapter_scope");
  assert.equal(bu.writes.length,0);
  await assert.rejects(rosterLib.removeFromRoster(FOUNDER,RYAN,bu.db,RYAN_TEAM),e=>e.code==="founder_cannot_be_removed");
});
