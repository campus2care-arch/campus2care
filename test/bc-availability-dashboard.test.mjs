import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

const base = new URL("../app/api/", import.meta.url);
const buSource = await readFile(new URL("availability-dashboard/metrics/route.ts", base), "utf8");
const bcSource = await readFile(new URL("bc-availability-dashboard/metrics/route.ts", base), "utf8");
const bcBanner = await readFile(new URL("bc-availability-dashboard/banner/route.ts", base), "utf8");
const compiled = ts.transpileModule(bcSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const GET = (await import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"))).GET;
const titled = value => ({title:[{plain_text:value}]});
const rich = value => ({rich_text:[{plain_text:value}]});
const email = value => ({email:value});
const selected = value => ({select:{name:value}});
const checked = value => ({checkbox:value});
const BU_PIPELINE = "2a3fd7a6-1dcc-4b57-b394-0f8821b3a2c7";
const BU_PROFILES = "c8319a35-3872-4444-9446-efefd1b3e66b";
const BC_PIPELINE = "c62767c6-3b89-4f45-82d5-9b8a17eb71ee";
const BC_PROFILES = "561cdbe5-e97b-45af-a5c9-8148b721c833";
const days = Object.fromEntries(["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"].map(d => [d,rich("Unavailable")]));

async function check(pipeline=[],profiles=[],fail=false) {
  const oldFetch = globalThis.fetch;
  const oldToken = process.env.NOTION_TOKEN;
  const called = [];
  process.env.NOTION_TOKEN = "test-only";
  globalThis.fetch = async url => {
    const source = String(url).match(/\/data_sources\/([^/]+)\/query/)?.[1];
    called.push(source);
    if (source === BU_PIPELINE || source === BU_PROFILES) throw new Error("Cross-campus query");
    if (fail) return Response.json({message:"unavailable"},{status:503});
    return Response.json({results:source===BC_PIPELINE?pipeline:source===BC_PROFILES?profiles:[],has_more:false});
  };
  try {
    const response = await GET();
    return {response,json:await response.json(),called};
  } finally {
    globalThis.fetch=oldFetch;
    if (oldToken===undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN=oldToken;
  }
}

test("BC route exclusively queries BC sources and identifies a completed seven-day schedule",async ()=>{
  const applicant = {id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",properties:{Volunteer:titled("Test BC Applicant"),Email:email("bc@example.test")}};
  const profile = {id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",properties:{
    Volunteer:titled("Test BC Applicant"),Email:email("bc@example.test"),"Identity Status":selected("Confirmed"),
    "Needs New Availability":checked(false),Superseded:checked(false),
    "Volunteer Record":{relation:[{id:applicant.id}]},...days
  }};
  const {response,json,called}=await check([applicant],[profile]);
  assert.equal(response.status,200);
  assert.deepEqual(called.sort(),[BC_PIPELINE,BC_PROFILES].sort());
  assert.equal(json.totalVolunteers,1);
  assert.equal(json.completedAvailabilityProfiles,1);
  assert.equal(json.missingAvailabilityProfiles,0);
  assert.ok(!JSON.stringify(json).includes("bc@example.test"));
});
test("BC metrics do not count incomplete, superseded, or unconfirmed availability",async ()=>{
  const applicant={id:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",properties:{Volunteer:titled("BC Only"),Email:email("bc2@example.test")}};
  const profile={id:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",properties:{Volunteer:titled("BC Only"),Email:email("bc2@example.test"),"Identity Status":selected("Confirmed"),"Needs New Availability":checked(false),Superseded:checked(false),...days,Monday:rich("")}};
  const r=await check([applicant],[profile]);
  assert.equal(r.json.totalVolunteers,1);
  assert.equal(r.json.completedAvailabilityProfiles,0);
  assert.equal(r.json.missingAvailabilityProfiles,1);
});
test("BC source errors fail closed rather than borrowing BU counts",async ()=>{
  const r=await check([],[],true);
  assert.equal(r.response.status,503);
  assert.ok(r.json.error);
  assert.equal(r.json.totalVolunteers,undefined);
});
test("BU route remains identical to existing source and BC banner has a separate URL",()=>{
  assert.match(buSource,new RegExp(BU_PIPELINE));
  assert.match(buSource,new RegExp(BU_PROFILES));
  assert.doesNotMatch(bcSource,new RegExp(BU_PIPELINE));
  assert.doesNotMatch(bcSource,new RegExp(BU_PROFILES));
  assert.match(bcBanner,/sharedBannerHTML/);
  assert.match(bcBanner,/replaceAll\("\/api\/availability-dashboard\/metrics", "\/api\/bc-availability-dashboard\/metrics"\)/);
  assert.match(bcBanner,/Boston College · Availability/);
});
