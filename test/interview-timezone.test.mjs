import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../lib/interview-timezone.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = await import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"));

test("Eastern civil morning adjusts from EST to EDT", () => {
  assert.equal(mod.easternLocalToInstant("2026-01-12", 540).toISOString(), "2026-01-12T14:00:00.000Z");
  assert.equal(mod.easternLocalToInstant("2026-06-15", 540).toISOString(), "2026-06-15T13:00:00.000Z");
});

test("DST spring gap and fall fold are rejected, not silently reassigned", () => {
  assert.throws(() => mod.easternLocalToInstant("2026-03-08", 150), /ambiguous_or_nonexistent_local_time/);
  assert.throws(() => mod.easternLocalToInstant("2026-11-01", 90), /ambiguous_or_nonexistent_local_time/);
});

test("ordinary times on both clock-change dates remain valid", () => {
  assert.equal(mod.easternLocalToInstant("2026-03-08", 180).toISOString(), "2026-03-08T07:00:00.000Z");
  assert.equal(mod.easternLocalToInstant("2026-11-01", 180).toISOString(), "2026-11-01T08:00:00.000Z");
});

test("UTC instants convert to New York calendar dates and minutes", () => {
  assert.deepEqual(mod.instantToEasternLocal(new Date("2026-11-02T14:00:00.000Z")), { date:"2026-11-02", minute:540 });
  assert.deepEqual(mod.instantToEasternLocal(new Date("2026-07-04T03:00:00.000Z")), { date:"2026-07-03", minute:1380 });
});

test("next-day cutoff compares Boston calendar dates, including UTC and DST boundaries", () => {
  const allowed = mod.isNextDayOrLaterInEasternTime;
  assert.equal(allowed(new Date("2026-11-04T23:50:00Z"), new Date("2026-11-04T13:00:00Z")), false);
  assert.equal(allowed(new Date("2026-11-05T05:00:00Z"), new Date("2026-11-05T04:59:00Z")), true);
  assert.equal(allowed(new Date("2026-11-05T04:30:00Z"), new Date("2026-11-05T02:00:00Z")), false);
  assert.equal(allowed(new Date("2026-03-08T07:00:00Z"), new Date("2026-03-08T06:00:00Z")), false);
  assert.equal(allowed(new Date("2026-03-09T04:00:00Z"), new Date("2026-03-09T03:59:00Z")), true);
});

test("invalid dates and times fail closed", () => {
  assert.throws(() => mod.easternLocalToInstant("2026-02-30", 600), /invalid_local_interview_date/);
  assert.throws(() => mod.easternLocalToInstant("2026-11-02", 1440), /invalid_local_interview_time/);
  assert.throws(() => mod.easternLocalToInstant("2026-11-02", 601.5), /invalid_local_interview_time/);
});
