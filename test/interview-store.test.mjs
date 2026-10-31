import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const compile = (text) => ts.transpileModule(text, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const asUrl = (value) => "data:text/javascript;base64," + Buffer.from(value).toString("base64");
const policy = asUrl(compile(await readFile(new URL("../lib/interview-week-policy.ts", import.meta.url), "utf8")));
const availability = asUrl(compile((await readFile(new URL("../lib/interview-availability.ts", import.meta.url), "utf8")).replace("./interview-week-policy", policy)));
const fakeBlob = asUrl([
  "const objects = new Map(); let version = 0; let race = false;",
  "export function raceNextRead() { race = true; }",
  "export async function get(path) {",
  "  const row = objects.get(path);",
  "  if (race && row) { race = false; objects.set(path, { body:row.body, etag:'version-' + ++version }); }",
  "  return row ? { statusCode:200, stream:new Response(row.body).body, blob:{ etag:row.etag } } : null;",
  "}",
  "export async function head(path) {",
  "  const row = objects.get(path); return row ? { etag:row.etag } : null;",
  "}",
  "export async function put(path, body, opts) {",
  "  const current = objects.get(path);",
  "  if (!opts.allowOverwrite && current) throw new Error('already exists');",
  "  if (opts.ifMatch && current?.etag !== opts.ifMatch) throw new Error('Precondition failed');",
  "  if (opts.allowOverwrite && !opts.ifMatch) throw new Error('unsafe unconditional overwrite');",
  "  const etag = 'version-' + ++version;",
  "  objects.set(path, { body, etag }); return { etag };",
  "}",
].join("\n"));
const source = compile(await readFile(new URL("../lib/interview-store.ts", import.meta.url), "utf8"))
  .replace('from "@vercel/blob"', 'from "' + fakeBlob + '"')
  .replace('from "./interview-availability"', 'from "' + availability + '"');
const store = await import(asUrl(source));
const blob = await import(fakeBlob);

test("EA availability store fails closed before configured activation", () => {
  delete process.env.INTERVIEW_STAFF_ENABLED;
  delete process.env.INTERVIEW_BLOB_READ_WRITE_TOKEN;
  assert.throws(() => store.staffStoreToken(), /interview_staff_storage_unavailable/);
});

test("EA recurring schedule persists and rejects stale concurrent updates", async () => {
  process.env.INTERVIEW_STAFF_ENABLED = "true";
  process.env.INTERVIEW_BLOB_READ_WRITE_TOKEN = "only-a-test-store";
  const email = "availability-test@campus2care.org";
  const recurring = [{ weekday: 0, windows: [{ startMinute: 600, endMinute: 720 }] }];
  const revision = await store.saveTemplate(email, recurring, null);
  assert.equal(typeof revision, "string");
  const saved = await store.getTemplate(email);
  assert.equal(saved.value.eaId, email);
  assert.deepEqual(saved.value.recurringWindows, recurring);
  const newRevision = await store.saveTemplate(email, recurring, saved.revision);
  assert.notEqual(newRevision, saved.revision);
  await assert.rejects(store.saveTemplate(email, [], saved.revision), /Precondition/);
});

test("weekly confirmation is separate from template and survives readback", async () => {
  process.env.INTERVIEW_STAFF_ENABLED = "true";
  process.env.INTERVIEW_BLOB_READ_WRITE_TOKEN = "only-a-test-store";
  const email = "weekly-test@campus2care.org";
  const record = {
    eaId: email, weekStart: "2026-11-02", status: "confirmed",
    confirmedAt: "2026-10-29T18:00:00Z",
    recurringWindows: [{ weekday: 2, windows: [{ startMinute: 780, endMinute: 900 }] }],
    overrides: [{ date: "2026-11-04", kind: "replace", windows: [{ startMinute: 840, endMinute: 900 }] }],
  };
  const revision = await store.saveWeek(email, record.weekStart, record, null);
  const saved = await store.getWeek(email, record.weekStart);
  assert.equal(saved.revision, revision);
  assert.deepEqual(saved.value, record);
  await assert.rejects(store.saveWeek("someone-else@campus2care.org", record.weekStart, record, null), /invalid_week_confirmation/);
});

test("a concurrent save during read cannot give old content a newer write revision", async () => {
  process.env.INTERVIEW_STAFF_ENABLED = "true";
  process.env.INTERVIEW_BLOB_READ_WRITE_TOKEN = "only-a-test-store";
  const email = "read-race@campus2care.org";
  const firstRevision = await store.saveTemplate(email, [], null);
  blob.raceNextRead();
  const snapshot = await store.getTemplate(email);
  assert.equal(snapshot.revision, firstRevision);
  await assert.rejects(store.saveTemplate(email, [], snapshot.revision), /Precondition/);
});

test("week editing is bounded and uses New York civil days", () => {
  const now = new Date("2026-10-28T08:00:00Z");
  assert.equal(store.currentNYDate(now), "2026-10-28");
  assert.equal(store.permittedWeek("2026-11-02", now), true);
  assert.equal(store.permittedWeek("2026-10-19", now), false);
  assert.equal(store.permittedWeek("2026-12-07", now), false);
});
