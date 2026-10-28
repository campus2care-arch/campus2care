import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source=await readFile(new URL("../lib/interview-calendar-provider.ts",import.meta.url),"utf8");
const compiled=ts.transpileModule(source,{
  compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022},
}).outputText;
const provider=await import("data:text/javascript;base64,"+Buffer.from(compiled).toString("base64"));
const base="https://www.googleapis.com/calendar/v3/calendars/primary/events";
const setup=()=>{
  process.env.VERCEL_ENV="preview";
  process.env.INTERVIEW_CALENDAR_WRITES_ENABLED="true";
  const events=new Map();
  const calls=[];
  const transport=async(url,init={})=>{
    const parsed=new URL(url);
    const method=init.method??"GET";
    calls.push({url:parsed,method,init});
    const id=parsed.pathname.slice((base+"/").length);
    if(method==="GET"){
      const event=events.get(id);
      return event
        ? Response.json(event)
        : new Response("missing",{status:404});
    }
    if(method==="POST"){
      const body=JSON.parse(init.body);
      assert.equal(parsed.searchParams.get("sendUpdates"),"none");
      assert.equal(body.attendees,undefined);
      events.set(body.id,{...body,status:"confirmed",conferenceData:{
        entryPoints:[{entryPointType:"video",uri:"https://meet.google.com/abc-defg-hij"}],
      }});
      return Response.json(events.get(body.id));
    }
    if(method==="DELETE"){
      events.delete(id);
      return new Response(null,{status:204});
    }
    throw new Error("unexpected_method");
  };
  return {events,calls,transport};
};
const input={
  accessToken:"synthetic-access-token-for-tests",
  operationKey:"synthetic-calendar-create-001",
  startsAt:"2026-11-02T15:00:00.000Z",
  endsAt:"2026-11-02T15:20:00.000Z",
};

test("Calendar writes remain disabled outside preview regardless of flag",async()=>{
  process.env.VERCEL_ENV="production";
  process.env.INTERVIEW_CALENDAR_WRITES_ENABLED="true";
  await assert.rejects(provider.createSyntheticInterviewCalendarEvent(input,async()=>{
    throw new Error("must_not_call_provider");
  }),/calendar_writes_disabled/);
});

test("synthetic event creation is idempotent and can be read and canceled",async()=>{
  const {events,calls,transport}=setup();
  const first=await provider.createSyntheticInterviewCalendarEvent(input,transport);
  const second=await provider.createSyntheticInterviewCalendarEvent(input,transport);
  assert.equal(first.id,second.id);
  assert.equal(first.meetUrl,"https://meet.google.com/abc-defg-hij");
  assert.equal(events.size,1);
  assert.equal(calls.filter((call)=>call.method==="POST").length,1);
  assert.equal(calls[1].init.body.includes("attendees"),false);

  const read=await provider.readSyntheticInterviewCalendarEvent(
    input.accessToken,input.operationKey,transport);
  assert.equal(read.id,first.id);
  assert.equal(await provider.cancelSyntheticInterviewCalendarEvent(
    input.accessToken,input.operationKey,transport),true);
  assert.equal(await provider.readSyntheticInterviewCalendarEvent(
    input.accessToken,input.operationKey,transport),null);
  assert.equal(await provider.cancelSyntheticInterviewCalendarEvent(
    input.accessToken,input.operationKey,transport),true);
});

test("invalid intervals and access tokens fail before provider calls",async()=>{
  process.env.VERCEL_ENV="preview";
  process.env.INTERVIEW_CALENDAR_WRITES_ENABLED="true";
  let called=false;
  const transport=async()=>{called=true;throw new Error("unexpected")};
  await assert.rejects(provider.createSyntheticInterviewCalendarEvent(
    {...input,endsAt:"2026-11-02T15:21:00.000Z"},transport),
  /invalid_calendar_event_interval/);
  await assert.rejects(provider.readSyntheticInterviewCalendarEvent(
    "short",input.operationKey,transport),/invalid_calendar_lookup/);
  assert.equal(called,false);
});

test("uncertain provider outcomes are not converted into successful events",async()=>{
  const {transport}=setup();
  await assert.rejects(provider.createSyntheticInterviewCalendarEvent(input,async(url,init)=>{
    if(init.method==="GET")return new Response("missing",{status:404});
    throw new Error("timeout_after_provider_acceptance");
  }),/calendar_provider_outcome_unknown/);
});
