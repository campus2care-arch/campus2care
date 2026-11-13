import test from "node:test";
import assert from "node:assert/strict";
import {loadInterviewModule} from "./interview-test-loader.mjs";

const slots=loadInterviewModule("interview-founder-slots",{
  "./interview-staff-db":{interviewStaffDatabase:()=>{throw Error("live database forbidden in tests");}},
});
const reservationId="12345678-1234-4234-8234-123456789abc";
const president="president@campus2care.org";

function fixture(previous) {
  const actions=[];
  const db=async (strings,...values)=>{
    const sql=strings.join("?");
    actions.push(sql);
    if(sql.includes("FROM interview.reservation") && sql.includes("FOR UPDATE"))
      return [{id:reservationId,starts_at:new Date(Date.now()-60*60_000),
        ends_at:new Date(Date.now()-40*60_000),status:"confirmed",campus:"BU"}];
    if(sql.includes("SELECT outcome FROM interview.audit_event"))
      return previous ? [{outcome:previous}] : [];
    return [];
  };
  db.begin=fn=>fn(db);
  db.json=value=>value;
  return {db,actions};
}
test("no-show releases the reservation without deleting the calendar event",async()=>{
  const f=fixture();
  assert.deepEqual(await slots.recordReservationAttendance(reservationId,"no_show",president,f.db),
    {recorded:true,outcome:"no_show"});
  assert.equal(f.actions.filter(x=>x.includes("INSERT INTO interview.audit_event")).length,1);
  assert.equal(f.actions.filter(x=>x.includes("UPDATE interview.reservation")).length,1);
  assert.equal(f.actions.some(x=>x.includes("DELETE FROM")),false);
  assert.equal(f.actions.some(x=>x.includes("integration_outbox")),false);
});
test("repeating the same attendance outcome is idempotent",async()=>{
  const f=fixture("completed");
  assert.deepEqual(await slots.recordReservationAttendance(reservationId,"completed",president,f.db),
    {recorded:false,outcome:"completed"});
  assert.equal(f.actions.some(x=>x.includes("INSERT INTO interview.audit_event")),false);
});
test("attendance control requires founder and a valid booking",async()=>{
  const f=fixture();
  await assert.rejects(slots.recordReservationAttendance(reservationId,"no_show","ea@campus2care.org",f.db),
    e=>e.code==="founder_access_required");
  await assert.rejects(slots.recordReservationAttendance("bogus","no_show",president,f.db),
    e=>e.code==="invalid_reservation");
  await assert.rejects(slots.recordReservationAttendance(reservationId,"other",president,f.db),
    e=>e.code==="invalid_attendance");
});
