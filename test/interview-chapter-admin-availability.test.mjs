import test from "node:test";
import assert from "node:assert/strict";
import {loadInterviewModule} from "./interview-test-loader.mjs";

// Who may edit availability on someone else's behalf (?as= / asEmail). Real access rules,
// in-memory roster and stores. Synthetic rows only: no live database or mail.
const ANDREW="president@campus2care.org", MEGHAN="meghan.kelly@campus2care.org", RYAN="ryan.daves@campus2care.org";
const ZAHA="zaha.qamar@campus2care.org", CAYLA="cayla.mckay@campus2care.org", EA="other.ea@campus2care.org";
let ROSTER;
function resetRoster(){
  ROSTER={
    [ANDREW]:{id:"andrew-id",email:ANDREW,campuses:["BC"],teamRole:"lead",leadId:null},
    [MEGHAN]:{id:"meghan-id",email:MEGHAN,campuses:["BU"],teamRole:"lead",leadId:null},
    [RYAN]:{id:"ryan-id",email:RYAN,campuses:["BC"],teamRole:"lead",leadId:null},
    [ZAHA]:{id:"zaha-id",email:ZAHA,campuses:["BC"],teamRole:"shadow",leadId:"ryan-id"},
    [CAYLA]:{id:"cayla-id",email:CAYLA,campuses:["BU"],teamRole:"shadow",leadId:"meghan-id"},
    [EA]:{id:"ea-id",email:EA,campuses:["BC"],teamRole:"shadow",leadId:"andrew-id"},
  };
}
resetRoster();
const saved=[],audits=[];
const sql=async(strings,...values)=>{audits.push({actor:values[0],action:values[1],object:values[2]});return [];};
sql.json=v=>v;
const WEEK="2026-11-16";
const route=loadInterviewModule("../app/api/interview/staff/availability/route",{
  "next/server":{NextResponse:{json:(body,options={})=>({body,status:options.status??200})}},
  "../../../../../lib/interview-auth":{
    interviewBaseOrigin:()=>"https://www.campus2care.org",
    staffFromRequest:req=>req.actor??null,
  },
  "../../../../../lib/interview-store":{permittedWeek:week=>week===WEEK,staffStoreToken:()=>({})},
  "../../../../../lib/interview-week-choice":{needsCurrentWeekAcknowledgement:()=>false},
  "../../../../../lib/interview-week-db":{
    isPostgresInterviewWeeksEnabled:()=>true,
    getDbInterviewTemplate:async()=>({value:null,revision:null}),
    getAuthoritativeInterviewWeek:async()=>({value:null,revision:null,approvalSource:"ea"}),
    saveAuthoritativeInterviewWeek:async(email,week,record,revision,options)=>{saved.push({email,options});return {revision:"db:2",conflictedBookings:0};},
    InterviewWeekConflict:class extends Error{},
  },
  "../../../../../lib/interview-staff-db":{
    productionStaffEnabled:()=>true,
    rosterMember:async(email)=>ROSTER[email]??null,
    interviewStaffDatabase:()=>sql,
  },
});
const actors={
  [ANDREW]:{email:ANDREW,role:"admin"},
  [MEGHAN]:{email:MEGHAN,role:"chapter_admin",campus:"BU"},
  [RYAN]:{email:RYAN,role:"chapter_admin",campus:"BC"},
  [ZAHA]:{email:ZAHA,role:"ea"},
};
const get=(who,as)=>route.GET({actor:actors[who]??null,
  nextUrl:new URL("https://www.campus2care.org/api/interview/staff/availability?week="+WEEK+(as?"&as="+encodeURIComponent(as):""))});
const post=(who,asEmail)=>route.POST({actor:actors[who]??null,
  headers:new Headers({origin:"https://www.campus2care.org","content-type":"application/json"}),
  text:async()=>JSON.stringify({action:"confirm",weekStart:WEEK,status:"confirmed",revision:null,recurringWindows:[],overrides:[],...(asEmail?{asEmail}:{})})});

test("chapter admins read and edit availability for shadowers on their own team",async()=>{
  for(const [lead,member] of [[RYAN,ZAHA],[MEGHAN,CAYLA]]){
    saved.length=0; audits.length=0;
    const r=await get(lead,member);
    assert.equal(r.status,200); assert.equal(r.body.email,member); assert.equal(r.body.onBehalf,true);
    const w=await post(lead,member);
    assert.equal(w.status,200);
    assert.equal(saved[0].email,member);
    assert.equal(saved[0].options.allowRyanFounderWeekEdit,false,"acting for others never unlocks founder-managed weeks");
    assert.deepEqual(audits,[{actor:lead,action:"chapter_admin_edit_availability",object:member+":"+WEEK}]);
  }
});

test("chapter admins are refused for anyone outside their team, and nothing is saved",async()=>{
  saved.length=0; audits.length=0;
  for(const [lead,target,label] of [[RYAN,CAYLA,"other campus"],[RYAN,EA,"another BC lead's shadower"],[RYAN,MEGHAN,"another chapter admin"],
    [RYAN,ANDREW,"the founder"],[MEGHAN,ZAHA,"other campus"],[MEGHAN,"nobody@campus2care.org","unknown person"]]){
    for(const r of [await get(lead,target),await post(lead,target)]){
      assert.equal(r.status,403,label); assert.equal(r.body.error,"outside_chapter_scope",label);
    }
  }
  assert.deepEqual(saved,[]); assert.deepEqual(audits,[]);
});

test("a chapter admin removed from the roster, or whose shadower was reassigned, loses on-behalf editing",async()=>{
  saved.length=0;
  ROSTER[ZAHA]={...ROSTER[ZAHA],leadId:"andrew-id"};
  assert.equal((await post(RYAN,ZAHA)).status,403);
  resetRoster(); delete ROSTER[RYAN];
  assert.equal((await post(RYAN,ZAHA)).status,403);
  resetRoster();
  assert.deepEqual(saved,[]);
});

test("own availability and founder behaviour are unchanged; interviewers cannot act for others",async()=>{
  saved.length=0; audits.length=0;
  const own=await get(RYAN); assert.equal(own.body.email,RYAN); assert.equal(own.body.onBehalf,false);
  assert.equal((await get(RYAN,RYAN)).body.onBehalf,false);
  assert.equal((await post(RYAN)).status,200);
  assert.equal(saved.at(-1).email,RYAN); assert.equal(saved.at(-1).options.allowRyanFounderWeekEdit,true);
  for(const target of [CAYLA,ZAHA,RYAN]){
    const r=await get(ANDREW,target); assert.equal(r.body.email,target); assert.equal(r.body.onBehalf,true);
  }
  assert.equal((await post(ANDREW,CAYLA)).status,200);
  assert.equal(audits.at(-1).action,"founder_edit_availability");
  const sneaky=await get(ZAHA,CAYLA);
  assert.equal(sneaky.body.email,ZAHA,"an interviewer's ?as= is ignored, as before");
  assert.equal((await get(null,CAYLA)).status,401);
});
