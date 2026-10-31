import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const asUrl = (code) => "data:text/javascript;base64," +
  Buffer.from(code).toString("base64");
const fakeAuth = asUrl(`export function authorizedRole(email) {
  return ["synthetic-ea@campus2care.org", "president@campus2care.org"].includes(email) ? "ea" : null;
}`);
const source = compile(await readFile(
  new URL("../lib/interview-calendar-freebusy.ts", import.meta.url), "utf8",
)).replace('from "./interview-auth"', 'from "' + fakeAuth + '"');
const lib = await import(asUrl(source));

const credentials = () => ({
  calendarId:"synthetic-ea@campus2care.org",
  accessToken:"synthetic-only-token-at-least-20-chars",
  startsAt:"2026-11-02T14:00:00.000Z",
  endsAt:"2026-11-02T17:00:00.000Z",
});

test("Calendar free/busy is disabled in production even with its flag enabled", async () => {
  process.env.VERCEL_ENV="production"; process.env.INTERVIEW_CALENDAR_READS_ENABLED="true";
  assert.equal(lib.calendarReadAccessEnabled(),false);
  await assert.rejects(lib.readInterviewerFreeBusy(credentials()),/calendar_read_access_disabled/);
});

test("Calendar read needs explicit staging enablement and a real provider grant", async () => {
  process.env.VERCEL_ENV="preview";process.env.INTERVIEW_CALENDAR_READS_ENABLED="false";
  await assert.rejects(lib.readInterviewerFreeBusy(credentials()),/calendar_read_access_disabled/);
  process.env.INTERVIEW_CALENDAR_READS_ENABLED="true";
  await assert.rejects(lib.readInterviewerFreeBusy({...credentials(),accessToken:""}),/calendar_access_not_granted/);
  await assert.rejects(lib.readInterviewerFreeBusy({...credentials(),calendarId:"other@example.org"}),/calendar_interviewer_not_authorized/);
});

test("read-only API uses a single allowlisted EA calendar and returns only busy time ranges",async()=>{
  process.env.VERCEL_ENV="preview";process.env.INTERVIEW_CALENDAR_READS_ENABLED="true";
  let called=0;
  const transport=async(url,opts)=>{
    called++;
    assert.equal(url,"https://www.googleapis.com/calendar/v3/freeBusy");
    assert.equal(opts.method,"POST");
    const body=JSON.parse(opts.body);
    assert.deepEqual(body.items,[{id:"synthetic-ea@campus2care.org"}]);
    assert.equal(body.timeZone,"America/New_York");
    return new Response(JSON.stringify({calendars:{
      "synthetic-ea@campus2care.org":{busy:[
        {start:"2026-11-02T15:00:00Z",end:"2026-11-02T15:25:00Z"},
        {start:"2026-11-02T14:00:00Z",end:"2026-11-02T14:20:00Z"},
      ]},
    }}),{status:200});
  };
  const busy=await lib.readInterviewerFreeBusy(credentials(),transport);
  assert.equal(called,1);
  assert.deepEqual(busy,[
    {start:"2026-11-02T14:00:00.000Z",end:"2026-11-02T14:20:00.000Z"},
    {start:"2026-11-02T15:00:00.000Z",end:"2026-11-02T15:25:00.000Z"},
  ]);
});

test("provider errors, missing calendar and malformed busy arrays fail closed",async()=>{
  process.env.VERCEL_ENV="preview";process.env.INTERVIEW_CALENDAR_READS_ENABLED="true";
  for(const data of [
    {calendars:{}},
    {calendars:{"synthetic-ea@campus2care.org":{errors:[{reason:"notFound"}],busy:[]}}},
    {calendars:{"synthetic-ea@campus2care.org":{busy:null}}},
    {calendars:{"synthetic-ea@campus2care.org":{busy:[{start:"garbage",end:"garbage"}]}}},
  ]){
    await assert.rejects(lib.readInterviewerFreeBusy(credentials(),
      async()=>new Response(JSON.stringify(data),{status:200})),
    /calendar_freebusy_/);
  }
  await assert.rejects(lib.readInterviewerFreeBusy(credentials(),
    async()=>new Response("unavailable",{status:403})),/calendar_freebusy_unavailable/);
});

test("20-minute slots respect 5-minute buffers and half-open boundaries",()=>{
  const busy=[{start:"2026-11-02T14:24:00.000Z",end:"2026-11-02T14:40:00.000Z"}];
  assert.equal(lib.calendarSlotIsFree("2026-11-02T14:00:00Z","2026-11-02T14:20:00Z",busy),false);
  assert.equal(lib.calendarSlotIsFree("2026-11-02T14:00:00Z","2026-11-02T14:20:00Z",busy,0),true);
  assert.equal(lib.calendarSlotIsFree("2026-11-02T14:40:00Z","2026-11-02T15:00:00Z",busy),true);
});
