import test from "node:test";
import assert from "node:assert/strict";
import {loadInterviewModule} from "./interview-test-loader.mjs";
class BookingError extends Error {constructor(code,status){super(code);this.code=code;this.status=status;}}
const id="11111111-1111-1111-1111-111111111111";
const row={id,status:"confirmed",campus:"BU",notion_page_id:"a".repeat(32),email:"test@campus2care.org"};
let identityAllowed=true;
const lib=loadInterviewModule("interview-production-cancellation",{
 "./interview-production-canary":{productionCanaryConfig:()=>({}),assertProductionCanaryIdentity:()=>{if(!identityAllowed)throw Error("identity denied");}},
 "./interview-production-booking":{ProductionBookingError:BookingError},
 "./interview-production-db":{productionInterviewDatabase:()=>{throw Error("no live DB");}},
});
function database({status="confirmed",running=false,replacement=false,missing=false}={}){
 const calls=[];
 const sql=async(strings,...args)=>{
  const text=strings.join("?");calls.push({text,args});
  if(text.includes("FROM interview.reservation r"))return missing?[]:[{...row,status}];
  if(text.includes("FROM interview.reschedule_request"))return replacement?[{id}]:[];
  if(text.includes("SELECT id,state FROM interview.integration_outbox"))return [{state:running?"processing":"queued"}];
  return [];
 };
 sql.begin=async callback=>callback(sql);
 return {sql,calls};
}
test("canary cancellation locks jobs, suppresses confirmations and retains slot claims until provider acknowledgement",async()=>{
 identityAllowed=true;const f=database();
 assert.deepEqual(await lib.cancelProductionCanaryBooking("t".repeat(43),id,f.sql),{id,status:"cancel_pending"});
 assert.ok(f.calls.some(c=>c.text.includes("SELECT id,state")&&c.text.includes("FOR UPDATE")));
 assert.ok(f.calls.some(c=>c.text.includes("SET status='cancel_pending'")));
 assert.ok(f.calls.some(c=>c.text.includes("state='suppressed'")));
 assert.ok(f.calls.some(c=>c.text.includes("INSERT INTO interview.integration_outbox")));
 assert.equal(f.calls.some(c=>c.text.includes("DELETE FROM interview.slot_claim")),false);
});
test("repeated cancellation is idempotent and rejects wrong identities or in-flight operations",async()=>{
 identityAllowed=true;
 for(const status of ["canceled","cancel_pending"]){const f=database({status});assert.equal((await lib.cancelProductionCanaryBooking("t".repeat(43),id,f.sql)).status,status);assert.equal(f.calls.length,1);}
 for(const options of [{running:true},{replacement:true},{missing:true},{status:"failed"}]){
  const f=database(options);await assert.rejects(lib.cancelProductionCanaryBooking("t".repeat(43),id,f.sql));
  assert.equal(f.calls.some(c=>c.text.includes("UPDATE" )&&!c.text.includes("FOR UPDATE")),false);
 }
 identityAllowed=false;await assert.rejects(lib.cancelProductionCanaryBooking("t".repeat(43),id,database().sql),/identity denied/);
 identityAllowed=true;
});
