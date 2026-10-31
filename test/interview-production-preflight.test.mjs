import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../lib/interview-production-preflight.ts", import.meta.url), "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const fakeDriver = "data:text/javascript,export default function postgres(){throw Error('not a read-only test')}";
const preflight = await import("data:text/javascript;base64," +
  Buffer.from(transpiled.replace('from "postgres"', 'from "' + fakeDriver + '"')).toString("base64"));

function safeEnv() {
  return {
    VERCEL_ENV: "production", INTERVIEW_DATA_ENV: "production",
    INTERVIEW_PRODUCTION_PREFLIGHT_ENABLED: "true",
    INTERVIEW_PRODUCTION_ENABLED: "false",
    INTERVIEW_BOOKING_ENABLED: "false",
    INTERVIEW_OUTREACH_ENABLED: "false",
    INTERVIEW_CALENDAR_WRITES_ENABLED: "false",
    INTERVIEW_GMAIL_SENDS_ENABLED: "false",
    INTERVIEW_OUTBOX_WORKER_ENABLED: "false",
    INTERVIEW_PRODUCTION_ENROLLMENT_ENABLED: "false",
    INTERVIEW_NOTION_WRITES_ENABLED: "false",
    INTERVIEW_DATABASE_HOST: "ep-controlled.eu-central-1.aws.neon.tech",
    INTERVIEW_DATABASE_URL: "postgres://readonly_user:unit_test_only@ep-controlled.eu-central-1.aws.neon.tech/campus2care?sslmode=require",
  };
}

test("read-only database preflight accepts only exact production credentials with outreach off", () => {
  const valid = safeEnv();
  assert.equal(preflight.validatedProductionPreflightConnection(valid), valid.INTERVIEW_DATABASE_URL);
});

test("a preview deployment or disabled preflight cannot use production credentials", () => {
  for (const patch of [
    {VERCEL_ENV:"preview"},
    {INTERVIEW_DATA_ENV:"staging"},
    {INTERVIEW_PRODUCTION_PREFLIGHT_ENABLED:"false"},
    {INTERVIEW_PRODUCTION_ENABLED:"true"},
  ]) {
    assert.throws(() => preflight.validatedProductionPreflightConnection({...safeEnv(),...patch}), /preflight_disabled/);
  }
});

test("any enabled write, send, or booking operation blocks the read-only preflight", () => {
  for (const key of [
    "INTERVIEW_BOOKING_ENABLED", "INTERVIEW_OUTREACH_ENABLED",
    "INTERVIEW_CALENDAR_WRITES_ENABLED", "INTERVIEW_GMAIL_SENDS_ENABLED",
    "INTERVIEW_OUTBOX_WORKER_ENABLED", "INTERVIEW_PRODUCTION_ENROLLMENT_ENABLED",
    "INTERVIEW_NOTION_WRITES_ENABLED",
  ]) {
    assert.throws(() => preflight.validatedProductionPreflightConnection({...safeEnv(),[key]:"true"}), /preflight_unsafe/);
  }
});

test("wrong branch host or non-Neon and insecure URLs are rejected without connection", () => {
  for (const patch of [
    {INTERVIEW_DATABASE_HOST:"ep-staging.eu-central-1.aws.neon.tech"},
    {INTERVIEW_DATABASE_URL:"postgres://user:secret@untrusted.example/c2c"},
    {INTERVIEW_DATABASE_URL:"postgres://user:secret@ep-controlled.eu-central-1.aws.neon.tech/c2c?sslmode=disable"},
    {INTERVIEW_DATABASE_URL:"https://ep-controlled.eu-central-1.aws.neon.tech/c2c"},
    {INTERVIEW_DATABASE_URL:""},
  ]) {
    assert.throws(() => preflight.validatedProductionPreflightConnection({...safeEnv(),...patch}), /preflight_invalid_database|preflight_unconfigured/);
  }
});
