import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadInterviewModule } from "./interview-test-loader.mjs";

const week = loadInterviewModule("interview-week-choice");

test("the safe default is the following Monday in Boston, not today", () => {
  assert.deepEqual(week.interviewWeekChoices(new Date("2026-11-04T12:01:00Z")),
    { current:"2026-11-02", next:"2026-11-09" });
  assert.equal(week.needsCurrentWeekAcknowledgement("2026-11-02",
    new Date("2026-11-04T12:01:00Z")),true);
  assert.equal(week.needsCurrentWeekAcknowledgement("2026-11-09",
    new Date("2026-11-04T12:01:00Z")),false);
});

test("the choice rolls over precisely at Monday midnight Eastern", () => {
  const sunday=week.interviewWeekChoices(new Date("2026-11-09T04:59:00Z"));
  const monday=week.interviewWeekChoices(new Date("2026-11-09T05:01:00Z"));
  assert.deepEqual(sunday,{current:"2026-11-02",next:"2026-11-09"});
  assert.deepEqual(monday,{current:"2026-11-09",next:"2026-11-16"});
});

test("daylight saving transitions do not shift the week boundary", () => {
  assert.deepEqual(week.interviewWeekChoices(new Date("2026-11-01T05:30:00Z")),
    {current:"2026-10-26",next:"2026-11-02"});
  assert.deepEqual(week.interviewWeekChoices(new Date("2026-11-02T05:01:00Z")),
    {current:"2026-11-02",next:"2026-11-09"});
});

test("API enforces current-week warning rather than relying on a client checkbox", () => {
  const route=readFileSync(new URL("../app/api/interview/staff/availability/route.ts",import.meta.url),"utf8");
  assert.match(route,/needsCurrentWeekAcknowledgement\(body\.weekStart\)/);
  assert.match(route,/body\.acknowledgeCurrentWeek !== true/);
  assert.match(route,/current_week_acknowledgement_required/);
  assert.ok(route.indexOf("current_week_acknowledgement_required") <
    route.indexOf("await saveAuthoritativeInterviewWeek("),
    "server must reject unacknowledged current-week edits before database save");
});

test("staff UI defaults to next Monday and requires conscious active-week acknowledgement", () => {
  const page=readFileSync(new URL("../app/interview/staff/availability/page.tsx",import.meta.url),"utf8");
  assert.match(page,/useState\(\(\) => interviewWeekChoices\(\)\.next\)/);
  assert.match(page,/Next week \(recommended\)/);
  assert.match(page,/Warning: changing this week/);
  assert.match(page,/setAcknowledgeCurrentWeek\(false\)/);
  assert.match(page,/currentWeek && !acknowledgeCurrentWeek/);
  assert.match(page,/founderManaged/);
  assert.match(page,/Existing published interview times are protected/);
});
