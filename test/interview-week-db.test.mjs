import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const compile = (src) => ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const data = (src) => "data:text/javascript;base64," + Buffer.from(src).toString("base64");

const fakeDatabase = data(`
  let stored = [];
  let error = null;
  export const statements = [];
  export function configureRows(rows) { stored = rows; error = null; statements.length = 0; }
  export function configureFailure(value) { error = value; }
  const query = async (strings, ...values) => {
    if (error) throw error;
    const text = strings.join("?");
    statements.push(text);
    if (text.includes("FROM interview.interviewer_week w")) return stored;
    if (text.includes("SELECT id FROM interview.interviewer")) return [{ id: "test-ea-uuid" }];
    if (text.includes("SELECT revision::text AS revision FROM interview.interviewer_week")) return stored.map(({revision})=>({revision}));
    if (text.includes("RETURNING revision::text AS revision")) return [{revision: stored.length ? "2" : "1"}];
    if (text.includes("SELECT starts_at, blocks_until FROM interview.reservation")) return [];
    return [];
  };
  query.begin = async (fn) => fn(query);
  export function interviewDatabase() { return query; }
`);
const fakeStore = data(`
  let value = { value:null, revision:null };
  export function setLegacy(v) { value=v; }
  export async function getWeek() { return value; }
`);
const fakeAvailability = data(`
  export function validateWeeklyConfirmation(record) {
    if (!record.weekStart) throw new Error("invalid_week");
  }
  export function buildInterviewSlots() { return []; }
`);
const source = compile(await readFile(new URL("../lib/interview-week-db.ts", import.meta.url), "utf8"))
  .replace('from "./interview-db"', 'from "' + fakeDatabase + '"')
  .replace('from "./interview-store"', 'from "' + fakeStore + '"')
  .replace('from "./interview-availability"', 'from "' + fakeAvailability + '"');
const db = await import(fakeDatabase);
const blob = await import(fakeStore);
const lib = await import(data(source));

const week = () => ({
  eaId:"synthetic-ea@campus2care.org",weekStart:"2026-11-02",
  status:"confirmed", confirmedAt:"2026-10-28T15:00:00.000Z",
  recurringWindows:[{weekday:0,windows:[{startMinute:540,endMinute:660}]}],
  overrides:[],
});

test("Postgres authority is preview-only and explicitly opted into", () => {
  process.env.VERCEL_ENV = "production"; process.env.INTERVIEW_WEEK_STORAGE = "postgres";
  assert.equal(lib.usePostgresInterviewWeeks(), false);
  process.env.VERCEL_ENV = "preview"; process.env.INTERVIEW_WEEK_STORAGE = "blob";
  assert.equal(lib.usePostgresInterviewWeeks(), false);
  process.env.INTERVIEW_WEEK_STORAGE = "postgres";
  assert.equal(lib.usePostgresInterviewWeeks(), true);
});

test("legacy Blob records remain readable but are marked as not migrated", async () => {
  db.configureRows([]);blob.setLegacy({value:week(),revision:"etag-1"});
  const found = await lib.getAuthoritativeInterviewWeek(week().eaId,week().weekStart);
  assert.equal(found.source,"legacy_blob");
  assert.equal(found.revision,"blob:etag-1");
  assert.deepEqual(found.value,week());
});

test("Postgres becomes authoritative once a week has been saved there", async () => {
  const record = week();
  db.configureRows([{
    status:"confirmed",confirmed_at:new Date(record.confirmedAt),
    effective_windows:record.recurringWindows,date_overrides:[],revision:"7",
  }]);
  blob.setLegacy({value:{...record,status:"unavailable"},revision:"obsolete"});
  const found=await lib.getAuthoritativeInterviewWeek(record.eaId,record.weekStart);
  assert.equal(found.source,"postgres");assert.equal(found.revision,"db:7");
  assert.deepEqual(found.value,record);
});

test("stale legacy etag cannot silently override a changed week", async () => {
  db.configureRows([]);blob.setLegacy({value:week(),revision:"etag-2"});
  await assert.rejects(
    lib.saveAuthoritativeInterviewWeek(week().eaId,week().weekStart,week(),"blob:etag-1"),
    /interview_week_modified_elsewhere/,
  );
});

test("missing revision cannot overwrite existing legacy week", async () => {
  db.configureRows([]);blob.setLegacy({value:week(),revision:"etag-2"});
  await assert.rejects(
    lib.saveAuthoritativeInterviewWeek(week().eaId,week().weekStart,week(),null),
    /interview_week_modified_elsewhere/,
  );
});

test("preexisting SQL revision must be current for update", async () => {
  db.configureRows([{revision:"8"}]);blob.setLegacy({value:null,revision:null});
  await assert.rejects(
    lib.saveAuthoritativeInterviewWeek(week().eaId,week().weekStart,week(),"db:7"),
    /interview_week_modified_elsewhere/,
  );
});

test("first explicit confirmation writes a week transaction with inactive interviewer default", async () => {
  db.configureRows([]);blob.setLegacy({value:null,revision:null});
  const result=await lib.saveAuthoritativeInterviewWeek(week().eaId,week().weekStart,week(),null);
  assert.deepEqual(result,{revision:"db:1",conflictedBookings:0});
  assert.ok(db.statements.some((s)=>s.includes("false, ARRAY['BU']::text[], 0")));
  assert.ok(db.statements.some((s)=>s.includes("INSERT INTO interview.interviewer_week")));
});
