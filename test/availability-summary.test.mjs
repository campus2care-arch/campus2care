import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";
const source = await readFile(new URL("../lib/availability-summary.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { availabilitySummary } = await import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"));
const days = Object.fromEntries(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map(day => [day, "Unavailable"]));
test("server derives weekly totals and weekday requirement from explicit seven-day blocks", () => {
  assert.deepEqual(availabilitySummary({ ...days, Monday: "9am–1pm", Saturday: "7am–8:30am, 2pm–4pm" }), {
    totalHours: 7.5, longestWeekdayBlockHours: 4, meetsWeekdayBlock: true,
  });
  assert.equal(availabilitySummary({ ...days, Sunday: "8am–8pm" }).meetsWeekdayBlock, false);
});
test("malformed, overlapping, reversed, and out-of-window blocks are rejected", () => {
  for (const Monday of ["after class", "9am–1pm, 12pm–2pm", "5pm–1pm", "6am–8am", "9am–11pm"]) {
    assert.equal(availabilitySummary({ ...days, Monday }), null);
  }
});
