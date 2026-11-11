import test from "node:test";
import assert from "node:assert/strict";
import {loadInterviewModule} from "./interview-test-loader.mjs";

// Three-level interview administration: Andrew (founder, all campuses), Meghan (BU chapter
// admin, own team), Ryan (BC chapter admin, own team). Real signed sessions and real route
// guards against in-memory stubs. Synthetic rows only: no live database, Notion, Calendar or mail.
process.env.INTERVIEW_AUTH_SECRET="test-only-auth-secret-very-long-not-a-real-password";
process.env.INTERVIEW_BASE_URL="https://www.campus2care.org";
process.env.VERCEL_ENV="production";
// Production-shaped allowlists: chapter presidents are also listed as "admin" and former leaders
// still appear as EAs. Neither must widen anyone's access.
process.env.INTERVIEW_ADMIN_EMAILS="president@campus2care.org,ryan.daves@campus2care.org,meghan.kelly@campus2care.org";
process.env.INTERVIEW_EA_EMAILS="cori.miller@campus2care.org,sophia.demoya@campus2care.org,cayla.mckay@campus2care.org";
delete process.env.INTERVIEW_CHAPTER_ADMINS; // exercise the built-in registry

const ANDREW="president@campus2care.org", MEGHAN="meghan.kelly@campus2care.org", RYAN="ryan.daves@campus2care.org";
const CAYLA="cayla.mckay@campus2care.org", CORI="cori.miller@campus2care.org", SOPHIA="sophia.demoya@campus2care.org";
const auth=loadInterviewModule("interview-auth");
const access=loadInterviewModule("interview-access");
const reply=(body,status=200)=>({status,body});

// Synthetic roster mirroring the production shape (ids are fake).
let ROSTER;
function resetRoster(){
  ROSTER={
    [ANDREW]:{id:"andrew-id",email:ANDREW,campuses:["BC"],teamRole:"lead",leadId:null},
    [MEGHAN]:{id:"meghan-id",email:MEGHAN,campuses:["BU"],teamRole:"lead",leadId:null},
    [RYAN]:{id:"ryan-id",email:RYAN,campuses:["BC"],teamRole:"lead",leadId:null},
    [CAYLA]:{id:"cayla-id",email:CAYLA,campuses:["BU"],teamRole:"shadow",leadId:"meghan-id"},
  };
}
resetRoster();
const lookups=[];
const rosterMember=async(email)=>{lookups.push(email);return ROSTER[email]??null;};

function request(path,email,method="GET",body,{cookie}={}){
  const value=cookie??(email?auth.makeSession(email):null);
  return {method,nextUrl:new URL("https://www.campus2care.org"+path),
    cookies:{get(name){return name==="c2c_interview_session"&&value?{value}:undefined;}},
    headers:new Headers(method==="POST"?{"origin":"https://www.campus2care.org","content-type":"application/json"}:{}),
    text:async()=>JSON.stringify(body??{})};
}

test("roles: Andrew founder; Meghan BU and Ryan BC chapter admins by default; admin label grants nothing",()=>{
  assert.deepEqual(auth.validateSession(auth.makeSession(ANDREW)),{email:ANDREW,role:"admin"});
  assert.deepEqual(auth.validateSession(auth.makeSession(MEGHAN)),{email:MEGHAN,role:"chapter_admin",campus:"BU"});
  assert.deepEqual(auth.validateSession(auth.makeSession(RYAN)),{email:RYAN,role:"chapter_admin",campus:"BC"});
  for(const who of [MEGHAN,RYAN]) assert.equal(access.isFounder(auth.validateSession(auth.makeSession(who))),false,who);
});

test("admin-label trap: dropping a chapter admin from the registry never falls through to founder",()=>{
  try{
    process.env.INTERVIEW_CHAPTER_ADMINS="someone.else@campus2care.org=BU";
    for(const who of [MEGHAN,RYAN]){
      assert.notEqual(auth.authorizedRole(who),"admin",who);
      assert.equal(auth.authorizedRole(who),null,who+" is neither chapter admin nor EA now");
    }
    assert.equal(auth.authorizedRole("someone.else@campus2care.org"),"chapter_admin");
    process.env.INTERVIEW_ADMIN_EMAILS+=",random.person@campus2care.org";
    assert.equal(auth.authorizedRole("random.person@campus2care.org"),null,"INTERVIEW_ADMIN_EMAILS cannot mint admins");
    assert.equal(auth.authorizedRole(ANDREW),"admin");
  }finally{delete process.env.INTERVIEW_CHAPTER_ADMINS;}
});

test("sessions: missing, tampered, foreign-domain and expired sessions are rejected",()=>{
  assert.equal(auth.validateSession(undefined),null);
  const good=auth.makeSession(MEGHAN);
  const [body,sig]=good.split(".");
  const forged=Buffer.from(JSON.stringify({v:1,email:ANDREW,expiresAt:Math.floor(Date.now()/1000)+3600})).toString("base64url");
  assert.equal(auth.validateSession(forged+"."+sig),null,"swapping the payload to the founder breaks the signature");
  assert.equal(auth.validateSession(body+".x"+sig.slice(1)),null);
  assert.throws(()=>auth.makeSession("meghan.kelly@gmail.com"));
  assert.equal(auth.validateSession(auth.makeSession(MEGHAN,Date.now()-9*3600e3)),null,"8h sessions expire");
});

const dashboard=loadInterviewModule("../app/api/interview/admin/dashboard/route",{
  "../../../../../lib/interview-admin-api":{interviewPrivateReply:reply},
  "../../../../../lib/interview-staff-db":{rosterMember},
  "../../../../../lib/interview-production-applicant-review":{ProductionAudienceReviewError:class extends Error{}},
  "../../../../../lib/interview-founder-dashboard":{
    loadFounderDashboard:async()=>({rows:[{key:"BC:a",campus:"BC"},{key:"BU:b",campus:"BU"}],mismatches:[],
      openSlots:{BU:0,BC:0},remainingCapacity:{BU:0,BC:0}}),
    summarize:(rows,campus)=>({campus})},
});
class SlotError extends Error{constructor(code){super(code);this.code=code;}}
const calls=[];
const slots=loadInterviewModule("../app/api/interview/admin/slots/route",{
  "../../../../../lib/interview-admin-api":{interviewPrivateReply:reply},
  "../../../../../lib/interview-staff-db":{interviewStaffEnabled:()=>true,rosterMember},
  "../../../../../lib/interview-founder-slots":{SlotError,
    readSlotTimetable:async(campus)=>{calls.push(["read",campus]);return [];},
    recordReservationAttendance:async(id,outcome,actor,db,chapter)=>{calls.push(["attendance",chapter?.leadId??null]);return {recorded:true,outcome};},
    generateSlotsFromAvailability:async()=>{calls.push(["generate"]);return {};},
    removeOpenSlot:async()=>{calls.push(["remove"]);return {};}},
});
class RosterError extends Error{constructor(code){super(code);this.code=code;}}
const staff=loadInterviewModule("../app/api/interview/admin/staff/route",{
  "../../../../../lib/interview-admin-api":{interviewPrivateReply:reply},
  "../../../../../lib/interview-staff-db":{interviewStaffEnabled:()=>true,rosterMember},
  "../../../../../lib/interview-staff-roster":{RosterError,
    parseRosterLines:(lines,campus)=>[{name:"Synthetic",email:"new@campus2care.org",campus,teamRole:"shadow",leadEmail:null}],
    validateRosterInput:(p)=>p,
    readRosterWeek:async(week,campus)=>{calls.push(["roster",campus]);return [];},
    upsertRoster:async(people,actor,db,chapter)=>{calls.push(["upsert",chapter?.leadId??null]);return {saved:1};},
    removeFromRoster:async(email,actor,db,chapter)=>{calls.push(["unroster",chapter?.leadId??null]);return {removed:true};},
    markRosterInvited:async(emails,db,chapter)=>{calls.push(["invited",chapter?.leadId??null]);return {marked:0};}},
});
const W="&week=2026-11-16";
const att={action:"attendance",reservationId:"12345678-1234-4234-8234-123456789abc",outcome:"completed"};
const D="/api/interview/admin/dashboard", S="/api/interview/admin/slots", R="/api/interview/admin/staff";

test("matrix: founder reads every campus and keeps every action, without a roster lookup",async()=>{
  lookups.length=0; calls.length=0;
  for(const c of ["ALL","BU","BC"]){
    assert.equal((await dashboard.GET(request(D+"?campus="+c,ANDREW))).status,200,c);
    assert.equal((await slots.GET(request(S+"?campus="+c+W,ANDREW))).status,200,c);
    assert.equal((await staff.GET(request(R+"?campus="+c+W,ANDREW))).status,200,c);
  }
  assert.equal((await dashboard.GET(request(D,ANDREW))).body.applicants.length,2);
  for(const body of [{action:"generate",campus:"BU",week:"2026-11-16"},{action:"remove",slotId:"12345678-1234-4234-8234-123456789abc"},att])
    assert.equal((await slots.POST(request(S,ANDREW,"POST",body))).status,200,body.action);
  assert.equal((await staff.POST(request(R,ANDREW,"POST",{action:"add",campus:"BC",lines:"x"}))).status,200);
  assert.deepEqual(calls.filter(c=>["attendance","upsert"].includes(c[0])).map(c=>c[1]),[null,null],"founder writes are unscoped");
  assert.deepEqual(lookups,[],"founder access never depends on the roster");
});

for(const [who,own,other,lead] of [[MEGHAN,"BU","BC","meghan-id"],[RYAN,"BC","BU","ryan-id"]]){
  test(`matrix: ${own} chapter admin reads ${own} only and writes only for their own team`,async()=>{
    calls.length=0;
    const d=await dashboard.GET(request(D,who));
    assert.equal(d.status,200); assert.deepEqual(d.body.applicants.map(r=>r.campus),[own]);
    for(const q of [other,"ALL"]){
      assert.equal((await dashboard.GET(request(D+"?campus="+q,who))).status,403,q);
      assert.equal((await slots.GET(request(S+"?campus="+q+W,who))).status,403,q);
      assert.equal((await staff.GET(request(R+"?campus="+q+W,who))).status,403,q);
    }
    assert.equal((await slots.GET(request(S+"?campus="+own+W,who))).status,200);
    assert.equal((await staff.GET(request(R+"?campus="+own+W,who))).status,200);
    assert.equal((await slots.POST(request(S,who,"POST",att))).status,200);
    for(const body of [{action:"generate",campus:own,week:"2026-11-16"},{action:"remove",slotId:"12345678-1234-4234-8234-123456789abc"}])
      assert.equal((await slots.POST(request(S,who,"POST",body))).status,403,body.action+" stays founder-only");
    const cross=await staff.POST(request(R,who,"POST",{action:"add",campus:other,lines:"x"}));
    assert.equal(cross.status,400); assert.equal(cross.body.error,"outside_chapter_scope");
    await staff.POST(request(R,who,"POST",{action:"add",campus:own,lines:"x"}));
    await staff.POST(request(R,who,"POST",{action:"remove",email:"x@campus2care.org"}));
    await staff.POST(request(R,who,"POST",{action:"mark_invited",emails:["x@campus2care.org"]}));
    assert.deepEqual(calls.filter(c=>["attendance","upsert","unroster","invited"].includes(c[0])).map(c=>c[1]),[lead,lead,lead,lead],
      "every write carries this admin's own team");
    assert.equal(calls.some(c=>c[0]==="generate"||c[0]==="remove"),false);
  });
}

test("revocation: a chapter admin removed from the roster, demoted or moved loses every admin API",async()=>{
  const variants=[["removed",()=>{delete ROSTER[MEGHAN];}],
    ["demoted to shadow",()=>{ROSTER[MEGHAN]={...ROSTER[MEGHAN],teamRole:"shadow"};}],
    ["moved to BC",()=>{ROSTER[MEGHAN]={...ROSTER[MEGHAN],campuses:["BC"]};}],
    ["made dual-campus",()=>{ROSTER[MEGHAN]={...ROSTER[MEGHAN],campuses:["BU","BC"]};}]];
  for(const [label,mutate] of variants){
    resetRoster(); mutate(); calls.length=0;
    for(const r of [await dashboard.GET(request(D,MEGHAN)),await slots.GET(request(S+"?campus=BU"+W,MEGHAN)),
      await staff.GET(request(R+"?campus=BU"+W,MEGHAN)),await slots.POST(request(S,MEGHAN,"POST",att)),
      await staff.POST(request(R,MEGHAN,"POST",{action:"add",campus:"BU",lines:"x"}))]){
      assert.equal(r.status,403,label); assert.equal(r.body.error,"chapter_admin_not_on_roster",label);
    }
    assert.deepEqual(calls,[],label+": nothing reached the data layer");
  }
  resetRoster();
});

test("former leaders, interviewers and anonymous callers get no admin API, even with modified parameters",async()=>{
  const forged=auth.makeSession(MEGHAN).split(".")[0]+".forged";
  for(const [label,req] of [["Cori",e=>request(e,CORI)],["Sophia",e=>request(e,SOPHIA)],["Cayla",e=>request(e,CAYLA)],
    ["anonymous",e=>request(e,null)],["forged cookie",e=>request(e,null,"GET",undefined,{cookie:forged})]]){
    assert.equal((await dashboard.GET(req(D+"?campus=BU"))).status,403,label);
    assert.equal((await slots.GET(req(S+"?campus=BU"+W))).status,403,label);
    assert.equal((await staff.GET(req(R+"?campus=BU"+W))).status,403,label);
  }
  for(const who of [CORI,SOPHIA,CAYLA]){
    assert.equal((await slots.POST(request(S,who,"POST",att))).status,403,who);
    assert.equal((await staff.POST(request(R,who,"POST",{action:"add",campus:"BU",lines:"x"}))).status,403,who);
  }
});

test("direct POSTs without the site origin or JSON content type are refused for chapter admins too",async()=>{
  const r=request(S,MEGHAN,"POST",att); r.headers=new Headers({"origin":"https://evil.example","content-type":"application/json"});
  assert.equal((await slots.POST(r)).status,403);
  const t=request(R,MEGHAN,"POST",{action:"add",campus:"BU",lines:"x"}); t.headers=new Headers({"origin":"https://www.campus2care.org","content-type":"text/plain"});
  assert.equal((await staff.POST(t)).status,403);
});

// ---- Data layer: team scope holds even if a route were misconfigured ----
const rosterLib=loadInterviewModule("interview-staff-roster",{
  "./interview-staff-db":{interviewStaffDatabase:()=>{throw Error("live database forbidden in tests");}},
});
function rosterDb(existing){
  const writes=[],sqls=[];
  const db=async(strings,...values)=>{const sql=strings.join("?");sqls.push({sql,values});
    if(sql.includes("SELECT lower(workspace_email) AS email, allowed_campuses"))
      return existing.filter(e=>values[0].includes(e.email));
    if(sql.includes("SELECT 1 FROM interview.interviewer")) return existing.filter(e=>e.email===values[0]).map(()=>({}));
    if(sql.includes("SELECT id FROM interview.interviewer")) return [{id:"meghan-id"}];
    if(/INSERT|UPDATE/.test(sql)) writes.push(sql);
    if(sql.includes("RETURNING id")) return [{id:"x"}];
    return [];};
  db.begin=fn=>fn(db); db.json=v=>v; return {db,writes,sqls};
}
const MEGHAN_TEAM={campus:"BU",email:MEGHAN,leadId:"meghan-id"};
const shadow=(email,extra={})=>({name:"Synthetic Person",email,campus:"BU",teamRole:"shadow",leadEmail:MEGHAN,...extra});

test("roster data layer: Meghan manages Cayla/Hannah-style team members, nobody else on BU",async()=>{
  const own=rosterDb([{email:CAYLA,allowed_campuses:["BU"],lead_interviewer_id:"meghan-id"}]);
  assert.deepEqual(await rosterLib.upsertRoster([shadow(CAYLA)],MEGHAN,own.db,MEGHAN_TEAM),{saved:1});
  assert.deepEqual(await rosterLib.upsertRoster([shadow("brand.new@campus2care.org")],MEGHAN,rosterDb([]).db,MEGHAN_TEAM),{saved:1});
  const cases=[
    ["another BU lead's shadower",[{email:"other.shadow@campus2care.org",allowed_campuses:["BU"],lead_interviewer_id:"sophia-id"}],shadow("other.shadow@campus2care.org")],
    ["unassigned BU shadower",[{email:"loose@campus2care.org",allowed_campuses:["BU"],lead_interviewer_id:null}],shadow("loose@campus2care.org")],
    ["another BU lead (Sophia)",[{email:SOPHIA,allowed_campuses:["BU"],lead_interviewer_id:null}],shadow(SOPHIA)],
    ["creating a new lead",[],shadow("new.lead@campus2care.org",{teamRole:"lead",leadEmail:null})],
    ["assigning to another lead",[],shadow("new@campus2care.org",{leadEmail:"sophia.demoya@campus2care.org"})],
    ["leaving the lead blank",[],shadow("new@campus2care.org",{leadEmail:null})],
    ["editing herself",[],shadow(MEGHAN)],
    ["the founder",[],shadow(ANDREW)],
    ["Ryan",[],shadow(RYAN)],
  ];
  for(const [label,existing,input] of cases){
    const f=rosterDb(existing);
    await assert.rejects(rosterLib.upsertRoster([input],MEGHAN,f.db,MEGHAN_TEAM),e=>e.code==="outside_chapter_scope",label);
    assert.equal(f.writes.length,0,label+" must write nothing");
  }
  for(const [label,email,existing] of [["Sophia's shadower","s@campus2care.org",[{email:"s@campus2care.org",allowed_campuses:["BU"],lead_interviewer_id:"sophia-id"}]],
    ["Sophia",SOPHIA,[{email:SOPHIA,allowed_campuses:["BU"],lead_interviewer_id:null}]],["herself",MEGHAN,[]]]){
    const f=rosterDb(existing);
    await assert.rejects(rosterLib.removeFromRoster(email,MEGHAN,f.db,MEGHAN_TEAM),e=>e.code==="outside_chapter_scope",label);
    assert.equal(f.writes.length,0,label);
  }
  const ok=rosterDb([{email:CAYLA,allowed_campuses:["BU"],lead_interviewer_id:"meghan-id"}]);
  assert.deepEqual(await rosterLib.removeFromRoster(CAYLA,MEGHAN,ok.db,MEGHAN_TEAM),{removed:true});
  const inv=rosterDb([]);
  await rosterLib.markRosterInvited([CAYLA,SOPHIA],inv.db,MEGHAN_TEAM);
  const update=inv.sqls.find(q=>q.sql.includes("SET invited_at"));
  assert.match(update.sql,/lead_interviewer_id = \?/); assert.ok(update.values.includes("meghan-id"));
});

const slotLib=loadInterviewModule("interview-founder-slots",{
  "./interview-staff-db":{interviewStaffDatabase:()=>{throw Error("live database forbidden in tests");}},
});
const rid="12345678-1234-4234-8234-123456789abc";
function attendanceDb(campus,interviewer_id){
  const actions=[];
  const db=async(strings)=>{const sql=strings.join("?");actions.push(sql);
    if(sql.includes("FROM interview.reservation")&&sql.includes("FOR UPDATE"))
      return [{id:rid,starts_at:new Date(Date.now()-3600e3),ends_at:new Date(Date.now()-2400e3),status:"confirmed",campus,interviewer_id}];
    return [];};
  db.begin=fn=>fn(db); db.json=v=>v; return {db,actions};
}

test("attendance data layer: own team's interviews only; other teams and campuses look missing",async()=>{
  const own=attendanceDb("BU","meghan-id");
  assert.deepEqual(await slotLib.recordReservationAttendance(rid,"no_show",MEGHAN,own.db,MEGHAN_TEAM),{recorded:true,outcome:"no_show"});
  for(const [label,campus,lead] of [["another BU team","BU","sophia-id"],["BC","BC","ryan-id"],["founder-led BC","BC","andrew-id"]]){
    const f=attendanceDb(campus,lead);
    await assert.rejects(slotLib.recordReservationAttendance(rid,"completed",MEGHAN,f.db,MEGHAN_TEAM),e=>e.code==="reservation_not_found",label);
    assert.equal(f.actions.some(a=>a.includes("INSERT INTO interview.audit_event")),false,label);
  }
  await assert.rejects(slotLib.recordReservationAttendance(rid,"completed",MEGHAN,own.db,{campus:"BU"}),e=>e.code==="founder_access_required");
  const founder=attendanceDb("BC","ryan-id");
  assert.deepEqual(await slotLib.recordReservationAttendance(rid,"completed",ANDREW,founder.db),{recorded:true,outcome:"completed"});
});
