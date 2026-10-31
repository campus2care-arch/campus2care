import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../lib/interview-db.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const fakeDriver = "data:text/javascript,export default function postgres(){throw Error('driver must not be called')}";
const lib = await import("data:text/javascript;base64," +
  Buffer.from(compiled.replace('from "postgres"', 'from "' + fakeDriver + '"')).toString("base64"));

test("interview database fails closed on production regardless of credentials", () => {
  process.env.VERCEL_ENV = "production";
  process.env.INTERVIEW_DATABASE_URL = "postgres://example@fake.neon.tech/db";
  assert.throws(() => lib.interviewDatabase(), /interview_database_production_disabled/);
});

test("interview database rejects missing and off-provider database URLs", () => {
  process.env.VERCEL_ENV = "preview";
  delete process.env.INTERVIEW_DATABASE_URL;
  assert.throws(() => lib.interviewDatabase(), /interview_database_not_configured/);
  process.env.INTERVIEW_DATABASE_URL = "postgres://example@untrusted.example/db";
  assert.throws(() => lib.interviewDatabase(), /interview_database_invalid_connection/);
});

test("booking requires an explicit preview-only feature flag", () => {
  process.env.VERCEL_ENV = "preview";
  process.env.INTERVIEW_BOOKING_ENABLED = "false";
  assert.throws(() => lib.requireInterviewStagingBooking(), /interview_booking_disabled/);
  process.env.INTERVIEW_BOOKING_ENABLED = "true";
  assert.doesNotThrow(() => lib.requireInterviewStagingBooking());
  process.env.VERCEL_ENV = "production";
  assert.throws(() => lib.requireInterviewStagingBooking(), /interview_booking_disabled/);
});

test("database conflict codes distinguish occupied slots from duplicate applicants", () => {
  assert.equal(lib.postgresConflictCode({ code: "23P01" }), "slot_taken");
  assert.equal(lib.postgresConflictCode({ code: "23505" }), "already_booked");
  assert.equal(lib.postgresConflictCode({ code: "42601" }), null);
  assert.equal(lib.postgresConflictCode(null), null);
});
