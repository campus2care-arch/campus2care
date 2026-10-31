import test from "node:test";
import assert from "node:assert/strict";

import { loadInterviewModule } from "./interview-test-loader.mjs";
const lib = loadInterviewModule("interview-availability");

const base = () => ({
  eaId: "ea-test",
  weekStart: "2026-11-02",
  status: "confirmed",
  confirmedAt: "2026-10-29T16:00:00Z",
  recurringWindows: [{ weekday: 0, windows: [{ startMinute: 540, endMinute: 660 }] }],
  overrides: [],
});

test("week calculations use Monday civil dates, including daylight-saving changes", () => {
  assert.equal(lib.mondayForDate("2026-11-01"), "2026-10-26");
  assert.equal(lib.mondayForDate("2026-11-02"), "2026-11-02");
  assert.equal(lib.dateInWeek("2026-11-02", 6), "2026-11-08");
  assert.equal(lib.dateInWeek("2026-10-26", 6), "2026-11-01");
});

test("20-minute appointments with 5-minute buffers stay within EA availability", () => {
  const slots = lib.buildInterviewSlots(base(), [], 20, 5);
  assert.deepEqual(slots.map((s) => [s.date, s.startMinute, s.endMinute]), [
    ["2026-11-02", 540, 560],
    ["2026-11-02", 565, 585],
    ["2026-11-02", 590, 610],
    ["2026-11-02", 615, 635],
    ["2026-11-02", 640, 660],
  ]);
});

test("a long availability block becomes only nonoverlapping 20-minute choices", () => {
  const fourHoursTwenty = {
    ...base(),
    recurringWindows: [{ weekday: 0, windows: [{ startMinute: 14 * 60, endMinute: 18 * 60 + 20 }] }],
  };
  const slots = lib.buildInterviewSlots(fourHoursTwenty, [], 20, 5);
  assert.equal(slots.length, 10);
  assert.deepEqual(slots.map((s) => s.startMinute), [
    840, 865, 890, 915, 940, 965, 990, 1015, 1040, 1065,
  ]);
  assert.ok(slots.every((slot, i) => i === 0 ||
    slots[i - 1].endMinute + 5 <= slot.startMinute));
  assert.deepEqual(lib.buildInterviewSlots({ ...fourHoursTwenty, status: "unavailable" }), []);
});

test("a calendar conflict prevents intersecting appointments and buffers", () => {
  const slots = lib.buildInterviewSlots(base(), [
    { date: "2026-11-02", startMinute: 560, endMinute: 563 },
  ], 20, 5);
  assert.equal(slots.some((slot) => slot.startMinute === 540), false);
  assert.equal(slots.some((slot) => slot.startMinute === 565), true);
});

test("unconfirmed EAs are never offered; no-hours is an explicit response", () => {
  const pending = { ...base(), status: "pending", confirmedAt: null };
  const unavailable = { ...base(), status: "unavailable" };
  assert.deepEqual(lib.buildInterviewSlots(pending), []);
  assert.deepEqual(lib.buildInterviewSlots(unavailable), []);
  const readiness = lib.availabilityReadiness([pending], ["ea-test", "ea-other"]);
  assert.deepEqual(readiness.map((r) => [r.status, r.isResponded, r.openSlotCount]), [
    ["pending", false, 0], ["missing", false, 0],
  ]);
  assert.deepEqual(lib.availabilityReadiness([unavailable], ["ea-test"])[0].isResponded, true);
});

test("date-specific exceptions replace recurring hours without changing other weeks", () => {
  const record = {
    ...base(),
    overrides: [
      { date: "2026-11-02", kind: "replace", windows: [{ startMinute: 720, endMinute: 765 }] },
    ],
  };
  assert.deepEqual(lib.buildInterviewSlots(record).map((s) => s.startMinute), [720, 740]);
  assert.deepEqual(lib.buildInterviewSlots({ ...base(), overrides: [
    { date: "2026-11-02", kind: "unavailable" },
  ] }), []);
});

test("invalid, overlapping, or out-of-week windows fail closed", () => {
  assert.throws(() => lib.buildInterviewSlots({
    ...base(),
    recurringWindows: [{ weekday: 0, windows: [
      { startMinute: 540, endMinute: 600 },
      { startMinute: 590, endMinute: 650 },
    ] }],
  }), /overlapping_availability_windows/);
  assert.throws(() => lib.buildInterviewSlots({
    ...base(),
    overrides: [{ date: "2026-11-09", kind: "unavailable" }],
  }), /override_outside_week/);
  assert.throws(() => lib.dateInWeek("2026-11-03", 0), /week_must_start_monday/);
  assert.throws(() => lib.mondayForDate("2026-02-30"), /invalid_date/);
});

test("separate EA conflicts do not make the entire organization unavailable", () => {
  const firstEA = base();
  const secondEA = { ...base(), eaId: "ea-second" };
  const firstBusy = [{ date: "2026-11-02", startMinute: 540, endMinute: 660 }];
  assert.deepEqual(lib.buildInterviewSlots(firstEA, firstBusy), []);
  assert.equal(lib.buildInterviewSlots(secondEA).length, 6);
});

test("two EAs cannot be included twice in a weekly readiness calculation", () => {
  assert.throws(() => lib.availabilityReadiness([base(), base()], ["ea-test"]), /duplicate_ea_week/);
});
