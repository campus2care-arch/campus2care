import test from "node:test";
import assert from "node:assert/strict";
import {loadInterviewModule} from "./interview-test-loader.mjs";
const roster=loadInterviewModule("interview-staff-roster",{
  "./interview-staff-db":{interviewStaffDatabase:()=>{throw Error("no database in unit tests");}},
  "./interview-availability":{buildInterviewSlots:()=>[]},
});
const auth=loadInterviewModule("interview-auth");

test("bulk lines parse leads, shadowers and their assigned lead for the selected campus",()=>{
  const people=roster.parseRosterLines("Jane Doe, Jane.Doe@campus2care.org, lead\n\nSam Lee\tsam.lee@campus2care.org\tShadower\tjane.doe@campus2care.org","BC");
  assert.deepEqual(people,[
    {name:"Jane Doe",email:"jane.doe@campus2care.org",campus:"BC",teamRole:"lead",leadEmail:null},
    {name:"Sam Lee",email:"sam.lee@campus2care.org",campus:"BC",teamRole:"shadow",leadEmail:"jane.doe@campus2care.org"},
  ]);
});
test("only Campus2Care Workspace accounts can be added, with the failing line reported",()=>{
  assert.throws(()=>roster.parseRosterLines("Jane Doe, jane@bc.edu, lead","BC"),
    e=>e.code==="line_1:interviewer_email_must_be_campus2care_org");
  assert.throws(()=>roster.validateRosterInput({name:"Jo",email:"jo@campus2care.org",campus:"BC",teamRole:"lead",leadEmail:"x@campus2care.org"}),
    e=>e.code==="leads_have_no_lead");
  assert.throws(()=>roster.validateRosterInput({name:"Jo",email:"jo@campus2care.org",campus:"NU",teamRole:"lead"}),
    e=>e.code==="invalid_campus");
});
test("roster sessions sign in as interviewer only and never become admin",()=>{
  const before=process.env.INTERVIEW_AUTH_SECRET,admins=process.env.INTERVIEW_ADMIN_EMAILS,eas=process.env.INTERVIEW_EA_EMAILS;
  process.env.INTERVIEW_AUTH_SECRET="unit-test-secret-that-is-long-enough-123";
  process.env.INTERVIEW_ADMIN_EMAILS="";process.env.INTERVIEW_EA_EMAILS="";
  try{
    assert.throws(()=>auth.makeSession("new.bc@campus2care.org"),/not_authorized/);
    assert.throws(()=>auth.makeSession("someone@bc.edu",Date.now(),{roster:true}),/not_authorized/);
    const session=auth.makeSession("new.bc@campus2care.org",Date.now(),{roster:true});
    assert.deepEqual(auth.validateSession(session),{email:"new.bc@campus2care.org",role:"ea"});
    const founder=auth.makeSession("president@campus2care.org",Date.now(),{roster:true});
    assert.equal(auth.validateSession(founder).role,"admin");
  }finally{
    process.env.INTERVIEW_AUTH_SECRET=before;process.env.INTERVIEW_ADMIN_EMAILS=admins;process.env.INTERVIEW_EA_EMAILS=eas;
  }
});
