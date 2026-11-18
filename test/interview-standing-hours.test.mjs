import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadInterviewModule } from "./interview-test-loader.mjs";

const hours = loadInterviewModule("interview-standing-hours");
const availability = loadInterviewModule("interview-availability");
const mail = loadInterviewModule("interview-email");
const WEEK = "2026-11-16";
const CAYLA = "cayla.mckay@campus2care.org";
const emptyWeek = () => [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, windows: [] }));

// What the availability page used to POST. The editor hours never became effective_windows.
function legacyConfirmPayload(base, edited, weekStart) {
  const overrides = edited.flatMap((day) => JSON.stringify(day.windows) === JSON.stringify(base[day.weekday]?.windows ?? [])
    ? []
    : [{ date: availability.dateInWeek(weekStart, day.weekday), kind: "replace", windows: day.windows }]);
  return { recurringWindows: base, overrides };
}

test("confirming hours with no template used to store seven empty days", () => {
  const edited = emptyWeek();
  edited[1] = { weekday: 1, windows: [{ startMinute: 540, endMinute: 600 }] };
  const legacy = legacyConfirmPayload(emptyWeek(), edited, WEEK);
  assert.equal(hours.weekdaysHaveHours(legacy.recurringWindows), false);
  assert.equal(legacy.overrides.length, 1);
  assert.equal(legacy.overrides[0].date, "2026-11-17");

  const saved = hours.persistedHoursFromEditor(edited);
  assert.equal(hours.weekdaysHaveHours(saved.recurringWindows), true);
  assert.deepEqual(saved.overrides, []);
  assert.deepEqual(saved.recurringWindows[1].windows, [{ startMinute: 540, endMinute: 600 }]);

  const seen = hours.resolveStandingWindows(WEEK, {
    status: "confirmed", recurringWindows: legacy.recurringWindows, overrides: legacy.overrides,
    confirmedAt: "2026-11-13T23:17:25.529Z",
  }, null);
  assert.equal(seen.source, "week");
  assert.deepEqual(seen.windows[1].windows, edited[1].windows);
  const stored = hours.confirmationToStore({
    eaId: CAYLA, weekStart: WEEK, status: "confirmed", confirmedAt: "2026-11-13T23:17:25.529Z",
    recurringWindows: legacy.recurringWindows, overrides: legacy.overrides,
  });
  assert.deepEqual(stored.overrides, []);
  assert.deepEqual(stored.recurringWindows[1].windows, edited[1].windows);
});

test("a missing or blank confirmation does not erase standing hours", () => {
  const template = { recurringWindows: [{ weekday: 4, windows: [{ startMinute: 800, endMinute: 860 }] }] };
  assert.equal(hours.resolveStandingWindows(WEEK, null, template).source, "template");
  assert.deepEqual(hours.resolveStandingWindows(WEEK, null, template).windows[4].windows, template.recurringWindows[0].windows);
  const blank = hours.resolveStandingWindows(WEEK, {
    status: "confirmed", recurringWindows: emptyWeek(), overrides: [], confirmedAt: "2026-11-13T23:17:25.529Z",
  }, template);
  assert.equal(blank.source, "template");
  assert.equal(hours.weekdaysHaveHours(blank.windows), true);
  const optedOut = hours.resolveStandingWindows(WEEK, {
    status: "unavailable", recurringWindows: template.recurringWindows, overrides: [], confirmedAt: "2026-11-13T23:17:25.529Z",
  }, template);
  assert.equal(optedOut.source, "unavailable");
  assert.equal(hours.weekdaysHaveHours(optedOut.windows), false);
});

test("Wednesday and Thursday staff mail say hours carry forward and do not ask for reconfirmation", () => {
  process.env.INTERVIEW_BASE_URL = "https://www.campus2care.org";
  for (const kind of ["ea_request", "ea_reminder"]) {
    const text = mail.renderInterviewMessage({
      operationKey: "dispatch:" + kind + ":2026-11-11:person01",
      recipient: CAYLA, kind,
      link: "https://www.campus2care.org/interview/staff/availability",
    }).text;
    assert.match(text, /carry forward automatically/i);
    assert.match(text, /do not need to reconfirm/i);
    assert.match(text, /does not clear your hours/i);
    assert.doesNotMatch(text, /confirm next week/i);
    assert.doesNotMatch(text, /require weekly confirmation/i);
  }
});

test("a blank editor is not a standing save, and an explicit unavailable week is", () => {
  assert.equal(hours.blankStandingSave({
    mode: "template", recurringWindows: emptyWeek(),
  }), true);
  assert.equal(hours.blankStandingSave({
    mode: "confirmed", weekStart: WEEK, recurringWindows: emptyWeek(), overrides: [],
  }), true);
  assert.equal(hours.blankStandingSave({
    mode: "unavailable", weekStart: WEEK, recurringWindows: emptyWeek(), overrides: [],
  }), false);
  const edited = emptyWeek();
  edited[1] = { weekday: 1, windows: [{ startMinute: 540, endMinute: 600 }] };
  const legacy = legacyConfirmPayload(emptyWeek(), edited, WEEK);
  assert.equal(hours.weekdaysHaveHours(legacy.recurringWindows), false);
  assert.equal(hours.blankStandingSave({
    mode: "confirmed", weekStart: WEEK, recurringWindows: legacy.recurringWindows, overrides: legacy.overrides,
  }), false);
});

test("the availability page explains a blank save instead of clearing future weeks", () => {
  const page = readFileSync(new URL("../app/interview/staff/availability/page.tsx", import.meta.url), "utf8");
  assert.match(page, /empty_availability_windows/);
  assert.match(page, /does not clear future weeks/);
  assert.match(page, /No interviews during selected week/);
});

test("saving a confirmed week stores the editor hours, writes the template, and carries later weeks", async () => {
  const writes = [];
  const published = [];
  const db = async (parts, ...values) => {
    const sql = parts.join("?");
    writes.push({ sql, values });
    if (sql.includes("SELECT id FROM interview.interviewer")) return [{ id: "cayla" }];
    if (sql.includes("SELECT approval_source,revision")) return [];
    if (sql.includes("ON CONFLICT (interviewer_id, week_start)")) return [{ week_start: values[1] }];
    if (sql.includes("RETURNING revision")) return [{ revision: "1" }];
    if (sql.includes("FROM interview.reservation")) return [];
    return [];
  };
  db.json = (value) => value;
  db.begin = async (fn) => fn(db);
  const service = loadInterviewModule("interview-week-db", {
    "./interview-staff-db": { interviewStaffDatabase: () => db, productionStaffEnabled: () => true },
    "./interview-self-schedule": {
      BookingWarning: class extends Error {},
      publishOwnSchedule: async (_tx, _id, record) => { published.push(record.weekStart); return undefined; },
    },
  });
  const edited = emptyWeek();
  edited[0] = { weekday: 0, windows: [{ startMinute: 480, endMinute: 630 }] };
  const legacy = legacyConfirmPayload(emptyWeek(), edited, WEEK);
  const record = {
    eaId: CAYLA, weekStart: WEEK, status: "confirmed", confirmedAt: "2026-11-13T23:17:25.529Z",
    recurringWindows: legacy.recurringWindows, overrides: legacy.overrides,
  };
  await service.saveAuthoritativeInterviewWeek(CAYLA, WEEK, record, null);
  const weekInsert = writes.find((query) => query.sql.includes("INSERT INTO interview.interviewer_week"));
  assert.deepEqual(weekInsert.values[4][0].windows, [{ startMinute: 480, endMinute: 630 }]);
  assert.deepEqual(weekInsert.values[5], []);
  assert.equal(writes.some((query) => query.sql.includes("INSERT INTO interview.interviewer_template")), true);
  assert.ok(published.includes(WEEK));
  assert.ok(published.includes("2026-11-23"));
  assert.equal(published.includes("2026-11-09"), false);
});

test("marking one week unavailable does not replace the template with blanks", async () => {
  const writes = [];
  const db = async (parts) => {
    const sql = parts.join("?");
    writes.push(sql);
    if (sql.includes("SELECT id FROM interview.interviewer")) return [{ id: "cayla" }];
    if (sql.includes("SELECT approval_source,revision")) return [{ revision: "4", approval_source: "ea" }];
    if (sql.includes("RETURNING revision")) return [{ revision: "5" }];
    if (sql.includes("FROM interview.reservation")) return [];
    return [];
  };
  db.json = (value) => value;
  db.begin = async (fn) => fn(db);
  const service = loadInterviewModule("interview-week-db", {
    "./interview-staff-db": { interviewStaffDatabase: () => db, productionStaffEnabled: () => true },
    "./interview-self-schedule": {
      BookingWarning: class extends Error {},
      publishOwnSchedule: async () => undefined,
    },
  });
  await service.saveAuthoritativeInterviewWeek(CAYLA, WEEK, {
    eaId: CAYLA, weekStart: WEEK, status: "unavailable", confirmedAt: "2026-11-13T23:17:25.529Z",
    recurringWindows: emptyWeek(), overrides: [],
  }, "db:4");
  assert.equal(writes.some((sql) => sql.includes("interviewer_template")), false);
});

test("a confirmed save with no hours is rejected before any week or future slot is rewritten", async () => {
  let began = false;
  const db = async () => { throw new Error("should not query"); };
  db.begin = async () => { began = true; throw new Error("should not begin"); };
  const service = loadInterviewModule("interview-week-db", {
    "./interview-staff-db": { interviewStaffDatabase: () => db, productionStaffEnabled: () => true },
    "./interview-self-schedule": {
      BookingWarning: class extends Error {},
      publishOwnSchedule: async () => { throw new Error("should not publish"); },
    },
  });
  await assert.rejects(() => service.saveAuthoritativeInterviewWeek(CAYLA, WEEK, {
    eaId: CAYLA, weekStart: WEEK, status: "confirmed", confirmedAt: "2026-11-13T23:17:25.529Z",
    recurringWindows: emptyWeek(), overrides: [],
  }, null), /empty_availability_windows/);
  await assert.rejects(() => service.saveDbInterviewTemplate(CAYLA, emptyWeek(), null, WEEK), /empty_availability_windows/);
  assert.equal(began, false);
});
