import test from "node:test";
import assert from "node:assert/strict";
import {loadInterviewModule} from "./interview-test-loader.mjs";

// Exercise the actual signed session verifier and actual route guards, with only
// persistence and NextResponse replaced. No live sessions, services or messages.
process.env.INTERVIEW_AUTH_SECRET="test-only-auth-secret-very-long-not-a-real-password";
process.env.INTERVIEW_BASE_URL="https://www.campus2care.org";
process.env.INTERVIEW_EA_EMAILS="cori.miller@campus2care.org";
const auth=loadInterviewModule("interview-auth");
const calls={reads:[],attendance:[],removes:[],generated:[]};
class SlotError extends Error {
  constructor(code){super(code);this.code=code;}
}
const route=loadInterviewModule("../app/api/interview/admin/slots/route",{
  "../../../../../lib/interview-auth":{
    interviewBaseOrigin:auth.interviewBaseOrigin,
    staffFromRequest:auth.staffFromRequest
  },
  "../../../../../lib/interview-admin-api":{
    interviewPrivateReply:(body,status=200)=>({status,body})
  },
  "../../../../../lib/interview-staff-db":{
    interviewStaffEnabled:()=>true
  },
  "../../../../../lib/interview-founder-slots":{
    SlotError,
    readSlotTimetable:async(campus,week)=>{calls.reads.push({campus,week});return [{id:"slot",campus,week}];},
    recordReservationAttendance:async(id,outcome,actor)=>{calls.attendance.push({id,outcome,actor});return {recorded:true,outcome};},
    removeOpenSlot:async(id,actor)=>{calls.removes.push({id,actor});return {removed:true};},
    generateSlotsFromAvailability:async(campus,week,actor)=>{calls.generated.push({campus,week,actor});return {created:1};}
  }
});
function request(email,method="GET",options={}){
  const cookie=email?auth.makeSession(email):null;
  const url=new URL("https://www.campus2care.org/api/interview/admin/slots?campus=BU&week=2026-11-02");
  return {
    method,nextUrl:url,
    cookies:{get(name){return name==="c2c_interview_session"&&cookie?{value:cookie}:undefined;}},
    headers:new Headers(method==="POST"?{
      "origin":options.origin??"https://www.campus2care.org",
      "content-type":options.contentType??"application/json"
    }:{}),
    text:async()=>JSON.stringify(options.body??{})
  };
}
test("founder timetable requires a signed president session; rejects anonymous and EAs",async()=>{
  calls.reads.length=0;
  const guest=await route.GET(request(null));
  const ea=await route.GET(request("cori.miller@campus2care.org"));
  const founder=await route.GET(request("president@campus2care.org"));
  assert.equal(guest.status,403);
  assert.equal(ea.status,403);
  assert.equal(founder.status,200);
  assert.deepEqual(calls.reads,[{campus:"BU",week:"2026-11-02"}]);
});
test("attendance writes require founder, same-origin JSON, and valid action",async()=>{
  calls.attendance.length=0;
  const body={action:"attendance",reservationId:"12345678-1234-4234-8234-123456789abc",outcome:"no_show"};
  assert.equal((await route.POST(request(null,"POST",{body}))).status,403);
  assert.equal((await route.POST(request("cori.miller@campus2care.org","POST",{body}))).status,403);
  assert.equal((await route.POST(request("president@campus2care.org","POST",
    {body,origin:"https://evil.example"}))).status,403);
  assert.equal((await route.POST(request("president@campus2care.org","POST",
    {body,contentType:"text/plain"}))).status,403);
  assert.equal(calls.attendance.length,0);
  const successful=await route.POST(request("president@campus2care.org","POST",{body}));
  assert.equal(successful.status,200);
  assert.equal(successful.body.outcome,"no_show");
  assert.deepEqual(calls.attendance,[{id:body.reservationId,outcome:"no_show",actor:"president@campus2care.org"}]);
  assert.equal((await route.POST(request("president@campus2care.org","POST",
    {body:{...body,outcome:"unknown"}}))).status,400);
  assert.equal(calls.attendance.length,1);
});
