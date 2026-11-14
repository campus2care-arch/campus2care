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
const worker=loadInterviewModule("interview-production-worker",{
 "./interview-production-canary":{
   productionCanaryConfig:()=>({}),
   assertProductionCanaryIdentity:()=>true,
 },
 "./interview-production-db":{productionInterviewDatabase:()=>{throw Error("production DB access in test");}},
 "./interview-production-notion":{verifyLiveCanaryApplicant:async()=>({})},
 "./interview-teams":{
   readInterviewTeams:async()=>[mockTeam],
   teamForSlot:(all,lead,start,campus)=>all.find(x=>x.leadId===lead&&x.startsAt===start&&x.campus===campus),
 },
 "./interview-production-providers":{ProductionProviderError:ProviderError},
 "./interview-management-link":{interviewManagementLink:async()=>"https://www.campus2care.org/interview#token=synthetic-link"},
});
const id=row.id;
const calendar={id:"c2c"+"a".repeat(64),status:"confirmed",meetUrl:"https://meet.google.com/abc-defg-hij"};
const jobs={
 calendar:{id:"f".repeat(8)+"-1111-2222-3333-"+ "f".repeat(12),operation_key:"interview-calendar:create:"+id,provider:"google_calendar",action:"create_event",object_id:id,attempts:1},
 notion:{id:"f".repeat(8)+"-1111-2222-3333-"+ "e".repeat(12),operation_key:"interview-notion:confirmed:"+id,provider:"notion",action:"sync_interview",object_id:id,attempts:1},
 gmail:{id:"f".repeat(8)+"-1111-2222-3333-"+ "d".repeat(12),operation_key:"interview-mail:confirmation:"+id,provider:"gmail",action:"send_message",object_id:id,attempts:1},
};
function fakeDB({status=row.status,meetUrl=row.meet_url,messageState="queued",messageKind="confirmation",
  messageRecipient=row.email,startsAt=row.starts_at,staffRole="lead",assignedStaff=true,roster,messagePayload}={}){
 const calls=[];let reservation={...row,status,starts_at:startsAt,meet_url:meetUrl,calendar_event_id:meetUrl?calendar.id:null};
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
   if(text.includes("UPDATE interview.reservation")&&text.includes("status='canceled'")){
     reservation.status="canceled";return [{id}];
   }
   if(text.includes("FROM interview.schedule_slot s"))return roster ?? (assignedStaff
     ? [{id:members[0].id,email:"cori@campus2care.org",role:staffRole}] : []);
   if(text.includes("FROM interview.message"))return [{
     id:"cccccccc-cccc-cccc-cccc-cccccccccccc",recipient_ref:messageRecipient,kind:messageKind,
     state:messageState,gmail_message_id:messageState==="accepted"?"sent123":null,
     payload:messagePayload ?? {applicantFirstName:"Jordan",staffRole,campus:"BU",startsAt:startsAt.toISOString()},
   }];
   if(text.includes("UPDATE interview.message SET state='reconcile_required'"))return [{id}];
   if(text.includes("UPDATE interview.message SET state='accepted'"))return [];
   return [];
 };
 sql.json=(value)=>value;
 sql.begin=async cb=>cb(sql);
 return {db:sql,calls};
}
test("only exact Calendar, Notion and Gmail confirmation jobs can run",()=>{
 for(const job of Object.values(jobs))assert.equal(worker.isCanaryJob(job),true);
 const staffKey="interview-staff-confirmation:"+id+":"+members[0].id;
 assert.equal(worker.isCanaryJob({...jobs.gmail,operation_key:staffKey}),true);
 assert.equal(worker.isCanaryJob({...jobs.gmail,operation_key:staffKey+":extra"}),false);
 assert.equal(worker.isCanaryJob({...jobs.gmail,operation_key:"interview-mail:invitation:"+id}),false);
 assert.equal(worker.isCanaryJob({...jobs.calendar,action:"cancel_event"}),false);
});
test("staff reminder targets only assigned interviewer and suppresses canceled bookings",async()=>{
  const startAt=new Date(Date.now()+60*60000), staffId=members[0].id;
  const staffKey="interview-staff-reminder:"+id+":"+staffId+":"+startAt.getTime();
  const job={...jobs.gmail,operation_key:staffKey};
  assert.equal(worker.isCanaryJob(job),true);
  assert.equal(worker.isCanaryJob({...job,operation_key:staffKey+"bad"}),false);
  const f=fakeDB({status:"confirmed",meetUrl:calendar.meetUrl,startsAt:startAt,
    messageKind:"appointment_reminder",messageRecipient:members[0].email});
  let sent=0;
  const answer=await worker.handleProductionCanaryJob(job,{db:f.db,
    sendGmail:async(input)=>{
      sent++;assert.equal(input.email,members[0].email);
      assert.equal(input.staffId,staffId);
      assert.equal(input.managementLink,undefined);
      assert.equal(input.recipientRole,"lead");
      assert.equal(input.applicantEmail,row.email);
      return "staff-sent-123";
    }});
  assert.equal(answer.state,"done");assert.equal(sent,1);
  const unassigned=fakeDB({status:"confirmed",meetUrl:calendar.meetUrl,startsAt:startAt,
    messageKind:"appointment_reminder",assignedStaff:false});
  const denied=await worker.handleProductionCanaryJob(job,{db:unassigned.db,
    sendGmail:async()=>{throw Error("must not send");}});
  assert.equal(denied.state,"failed");
  const canceled=fakeDB({status:"canceled",meetUrl:calendar.meetUrl,startsAt:startAt,
    messageKind:"appointment_reminder"});
  const stop=await worker.handleProductionCanaryJob(job,{db:canceled.db,
    sendGmail:async()=>{throw Error("canceled reminder sent");}});
  assert.equal(stop.state,"done");
  assert.ok(canceled.calls.some(c=>c.text.includes("state='suppressed'")));
});
test("Calendar worker inserts Notion job only after unique Meet link is ready",async()=>{
 const f=fakeDB();const result=await worker.handleProductionCanaryJob(jobs.calendar,{
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
 const result=await worker.handleProductionCanaryJob(jobs.calendar,{
   db:f.db,createEvent:async()=>({...calendar,meetUrl:null}),
 });
 assert.equal(result.state,"retry");
 assert.equal(f.calls.some(x=>x.text.includes("INSERT INTO interview.integration_outbox")),false);
});
test("Notion is synchronized before the worker can queue confirmation email",async()=>{
 const f=fakeDB({meetUrl:calendar.meetUrl});let synced=0;
 const result=await worker.handleProductionCanaryJob(jobs.notion,{
   db:f.db,syncNotion:async input=>{synced++;assert.equal(input.pageId,row.notion_page_id);return "written";},
 });
 assert.equal(result.state,"done");
 assert.equal(synced,1);
 assert.ok(f.calls.some(x=>x.text.includes("INSERT INTO interview.message")));
 assert.ok(f.calls.some(x=>x.text.includes("INSERT INTO interview.integration_outbox")));
});
test("Notion error prevents Gmail job creation and is quarantined",async()=>{
 const f=fakeDB({meetUrl:calendar.meetUrl});
 const result=await worker.handleProductionCanaryJob(jobs.notion,{
   db:f.db,syncNotion:async()=>{throw new ProviderError("notion_unknown","reconcile_required");},
 });
 assert.equal(result.state,"reconcile_required");
 assert.equal(f.calls.some(x=>x.text.includes("INSERT INTO interview.message")),false);
});
test("Gmail is sent once after confirmed Notion sync, and previous acceptance is not resent",async()=>{
 const f=fakeDB({status:"confirmed",meetUrl:calendar.meetUrl});let sent=0;
 const result=await worker.handleProductionCanaryJob(jobs.gmail,{
   db:f.db,sendGmail:async()=>{sent++;return "sent123";},
 });
 assert.equal(result.state,"done");assert.equal(sent,1);
 assert.ok(f.calls.some(x=>x.text.includes("UPDATE interview.message SET state='reconcile_required'")));
 const accepted=fakeDB({status:"confirmed",meetUrl:calendar.meetUrl,messageState:"accepted"});
 const outcome=await worker.handleProductionCanaryJob(jobs.gmail,{
   db:accepted.db,sendGmail:async()=>{throw Error("duplicate send");},
 });
 assert.equal(outcome.state,"done");
});
test("Gmail ambiguous outcome remains reconciliation-required",async()=>{
 const f=fakeDB({status:"confirmed",meetUrl:calendar.meetUrl});
 const result=await worker.handleProductionCanaryJob(jobs.gmail,{
   db:f.db,sendGmail:async()=>{throw new ProviderError("gmail_timeout","reconcile_required");},
 });
 assert.equal(result.state,"reconcile_required");
});

test("cancellation completes Calendar then Notion then one cancellation email",async()=>{
 const cancelJob={...jobs.calendar,action:"cancel_event",operation_key:"interview-calendar:cancel:"+id};
 const notionJob={...jobs.notion,action:"cancel_interview",operation_key:"interview-notion:canceled:"+id};
 const gmailJob={...jobs.gmail,operation_key:"interview-mail:cancellation:"+id};
 const f=fakeDB({status:"cancel_pending",meetUrl:calendar.meetUrl});
 let canceled=0,cleared=0,sent=0;
 assert.equal((await worker.handleProductionCanaryJob(cancelJob,{db:f.db,cancelEvent:async()=>{canceled++;}})).state,"done");
 assert.equal(canceled,1);
 assert.equal((await worker.handleProductionCanaryJob(notionJob,{db:f.db,clearNotion:async()=>{cleared++;}})).state,"done");
 assert.equal(cleared,1);
 const g=fakeDB({status:"canceled",meetUrl:calendar.meetUrl,messageKind:"cancellation"});
 assert.equal((await worker.handleProductionCanaryJob(gmailJob,{db:g.db,sendGmail:async input=>{assert.equal(input.kind,"cancellation");sent++;return "cancel123";}})).state,"done");
 assert.equal(sent,1);
});
test("unknown Calendar cancellation keeps reservation claims and prevents downstream jobs",async()=>{
 const f=fakeDB({status:"cancel_pending",meetUrl:calendar.meetUrl});
 const result=await worker.handleProductionCanaryJob({...jobs.calendar,action:"cancel_event",operation_key:"interview-calendar:cancel:"+id},
  {db:f.db,cancelEvent:async()=>{throw new ProviderError("cancel_unknown","reconcile_required");}});
 assert.equal(result.state,"reconcile_required");
 assert.equal(f.calls.some(c=>c.text.includes("UPDATE interview.reservation")),false);
 assert.equal(f.calls.some(c=>c.text.includes("INSERT INTO interview.integration_outbox")),false);
});

test("applicant confirmation and reminder receive the management link",async()=>{
 for(const reminder of [false,true]){
  const startsAt=new Date(Date.now()+3600000);
  const job={...jobs.gmail,operation_key:reminder?"interview-reminder:"+id+":"+startsAt.getTime():jobs.gmail.operation_key};
  const f=fakeDB({status:"confirmed",meetUrl:calendar.meetUrl,startsAt,messageKind:reminder?"appointment_reminder":"confirmation"});
  const result=await worker.handleProductionCanaryJob(job,{db:f.db,sendGmail:async input=>{
   assert.equal(input.email,row.email);assert.equal(input.managementLink,"https://www.campus2care.org/interview#token=synthetic-link");
   return "applicant-sent-123";
  }});
  assert.equal(result.state,"done");
 }
});

test("booking confirmation queues the lead and attached shadows once, and stays off without the flag",async()=>{
  const previous=process.env.INTERVIEW_REAL_STAFF_CONFIRMATIONS_APPROVED;
  try{
    delete process.env.INTERVIEW_REAL_STAFF_CONFIRMATIONS_APPROVED;
    const off=fakeDB({meetUrl:calendar.meetUrl});
    assert.equal((await worker.handleProductionCanaryJob(jobs.notion,{
      db:off.db,syncNotion:async()=>({status:"written",applicantFirstName:"Jordan"}),
    })).state,"done");
    assert.equal(off.calls.filter(c=>String(c.args[0]??"").startsWith("interview-staff-confirmation:")).length,0);
    process.env.INTERVIEW_REAL_STAFF_CONFIRMATIONS_APPROVED="true";
    const roster=[
      {id:members[0].id,email:members[0].email,role:"lead"},
      {id:members[1].id,email:members[1].email,role:"shadow"},
      {id:"99999999-9999-9999-9999-999999999999",email:row.email,role:"shadow"},
    ];
    const on=fakeDB({meetUrl:calendar.meetUrl,roster});
    assert.equal((await worker.handleProductionCanaryJob(jobs.notion,{
      db:on.db,syncNotion:async()=>({status:"written",applicantFirstName:"Jordan Lee"}),
    })).state,"done");
    const staffInserts=on.calls.filter(c=>c.text.includes("INSERT INTO interview.message") &&
      String(c.args[0]).startsWith("interview-staff-confirmation:"));
    assert.deepEqual(staffInserts.map(c=>c.args[0]),[
      "interview-staff-confirmation:"+id+":"+members[0].id,
      "interview-staff-confirmation:"+id+":"+members[1].id,
    ]);
    assert.deepEqual(staffInserts.map(c=>c.args[1]),[members[0].email,members[1].email]);
    for(const insert of staffInserts){
      assert.match(insert.text,/'confirmation'/);
      assert.equal(insert.args[2],"BU");
      assert.equal(insert.args[4].applicantFirstName,"Jordan");
      assert.equal(insert.args[4].meetUrl,undefined);
      assert.equal(JSON.stringify(insert.args[4]).includes("token="),false);
      assert.equal(JSON.stringify(insert.args[4]).includes("meet.google"),false);
      assert.match(insert.text,/ON CONFLICT\(operation_key\) DO NOTHING/);
    }
    assert.ok(on.calls.some(c=>c.text.includes("INSERT INTO interview.message") &&
      c.args[0]==="interview-mail:confirmation:"+id));
    const rosterSql=on.calls.find(c=>c.text.includes("FROM interview.schedule_slot s") &&
      c.text.includes("i.staff_access"));
    assert.match(rosterSql.text,/\(i\.active OR p\.role='shadow'\)/);
    assert.match(rosterSql.text,/i\.removed_at IS NULL/);
    assert.match(rosterSql.text,/%@campus2care\.org/);
  }finally{
    if(previous===undefined)delete process.env.INTERVIEW_REAL_STAFF_CONFIRMATIONS_APPROVED;
    else process.env.INTERVIEW_REAL_STAFF_CONFIRMATIONS_APPROVED=previous;
  }
});

test("staff booking confirmation sends from the outbox and does not send after cancellation",async()=>{
  const previous=process.env.INTERVIEW_REAL_STAFF_CONFIRMATIONS_APPROVED;
  const logs=[];
  const original=console.info;
  console.info=(...args)=>logs.push(args.map(String).join(" "));
  process.env.INTERVIEW_REAL_STAFF_CONFIRMATIONS_APPROVED="true";
  const staffKey="interview-staff-confirmation:"+id+":"+members[0].id;
  const job={...jobs.gmail,operation_key:staffKey,attempts:1};
  try{
    const sent=[];
    const ready=fakeDB({status:"confirmed",meetUrl:calendar.meetUrl,messageRecipient:members[0].email});
    const done=await worker.handleProductionCanaryJob(job,{db:ready.db,sendStaffConfirmation:async input=>{
      sent.push(input);
      assert.equal(input.email,members[0].email);
      assert.equal(input.applicantFirstName,"Jordan");
      assert.equal(input.role,"lead");
      assert.equal(input.campus,"BU");
      assert.equal(input.meetUrl,undefined);
      assert.equal(Object.hasOwn(input,"meetUrl"),false);
      return "staff-confirmation-1";
    }});
    assert.equal(done.state,"done");
    assert.equal(sent.length,1);
    assert.equal(done.externalId,"staff-confirmation-1");
    const canceled=fakeDB({status:"canceled",meetUrl:calendar.meetUrl,messageRecipient:members[0].email});
    const stop=await worker.handleProductionCanaryJob(job,{db:canceled.db,sendStaffConfirmation:async()=>{
      throw Error("canceled staff confirmation sent");
    }});
    assert.equal(stop.state,"done");
    assert.ok(canceled.calls.some(c=>c.text.includes("state='suppressed'")));
    const removed=fakeDB({status:"confirmed",meetUrl:calendar.meetUrl,assignedStaff:false,
      messageRecipient:members[0].email});
    const denied=await worker.handleProductionCanaryJob(job,{db:removed.db,sendStaffConfirmation:async()=>{
      throw Error("removed staff confirmation sent");
    }});
    assert.equal(denied.state,"failed");
    assert.equal(denied.code,"production_staff_confirmation_unassigned");
    const oauth=fakeDB({status:"confirmed",meetUrl:calendar.meetUrl,messageRecipient:members[0].email});
    const held=await worker.handleProductionCanaryJob(job,{db:oauth.db,sendStaffConfirmation:async()=>{
      throw Error("google_provider_invalid_grant");
    }});
    assert.equal(held.state,"failed");
    assert.equal(held.classified,true);
    assert.equal(held.errorClass,"oauth_refresh");
    assert.notEqual(held.state,"reconcile_required");
    const ambiguous=fakeDB({status:"confirmed",meetUrl:calendar.meetUrl,messageRecipient:members[0].email});
    const uncertain=await worker.handleProductionCanaryJob(job,{db:ambiguous.db,sendStaffConfirmation:async()=>{
      throw Error("gmail response lost");
    }});
    assert.equal(uncertain.state,"reconcile_required");
    assert.equal(uncertain.errorClass,"outcome_uncertain");
    const text=logs.join("\n");
    assert.doesNotMatch(text,/meet\.google\.com/);
    assert.doesNotMatch(text,/token=/);
    assert.doesNotMatch(text,/test@campus2care\.org/);
    assert.match(text,/staff_confirmation_gmail/);
  }finally{
    console.info=original;
    if(previous===undefined)delete process.env.INTERVIEW_REAL_STAFF_CONFIRMATIONS_APPROVED;
    else process.env.INTERVIEW_REAL_STAFF_CONFIRMATIONS_APPROVED=previous;
  }
});

test("staff confirmation jobs are not claimed until the founder flag is on",async()=>{
  const previous=process.env.INTERVIEW_REAL_STAFF_CONFIRMATIONS_APPROVED;
  const capture=()=>{
    const calls=[];
    const db=async(parts,...args)=>{calls.push({text:parts.join("?"),args});return [];};
    db.begin=fn=>fn(db);
    return {db,calls};
  };
  try{
    delete process.env.INTERVIEW_REAL_STAFF_CONFIRMATIONS_APPROVED;
    const off=capture(false);
    assert.deepEqual(await worker.processProductionCanaryOutbox(1,{db:off.db}),
      {claimed:0,done:0,reconciliation:0,retry:0});
    const offClaim=off.calls.find(c=>c.text.includes("WITH candidate AS"));
    assert.match(offClaim.text,/interview-staff-confirmation:%/);
    assert.equal(offClaim.args.includes(true),false);
    assert.match(off.calls[0].text,/interview-staff-confirmation:%/);
    process.env.INTERVIEW_REAL_STAFF_CONFIRMATIONS_APPROVED="true";
    const on=capture(true);
    await worker.processProductionCanaryOutbox(1,{db:on.db});
    const onClaim=on.calls.find(c=>c.text.includes("WITH candidate AS"));
    assert.equal(onClaim.args.includes(true),true);
  }finally{
    if(previous===undefined)delete process.env.INTERVIEW_REAL_STAFF_CONFIRMATIONS_APPROVED;
    else process.env.INTERVIEW_REAL_STAFF_CONFIRMATIONS_APPROVED=previous;
  }
});
