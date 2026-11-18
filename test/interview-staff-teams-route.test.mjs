import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadInterviewModule } from "./interview-test-loader.mjs";

const WEEK = "2026-11-16";
const teams = [{
  id: "slot-1", revision: "3", approvedBy: null, campus: "BU", leadId: "lead-1",
  startsAt: "2026-11-17T15:00:00.000Z",
  participants: [{ email: "lead@campus2care.org", name: "Lead", role: "lead", available: true }],
}];

const route = loadInterviewModule("../app/api/interview/staff/teams/route", {
  "next/server": { NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200 }) } },
  "../../../../../lib/interview-auth": { staffFromRequest: (req) => req.actor ?? null },
  "../../../../../lib/interview-db": {
    interviewDatabase() { throw new Error("interview_database_production_disabled"); },
  },
  "../../../../../lib/interview-staff-db": {
    interviewStaffDatabase() { return { tag: "staff" }; },
  },
  "../../../../../lib/interview-teams": {
    readInterviewTeams: async (db) => {
      assert.equal(db.tag, "staff");
      return teams;
    },
  },
});

function request(actor, week = WEEK) {
  return {
    actor,
    nextUrl: new URL("https://www.campus2care.org/api/interview/staff/teams?week=" + encodeURIComponent(week)),
  };
}

test("staff teams reads the production staff database when the staging client is disabled", async () => {
  const result = await route.GET(request({ email: "lead@campus2care.org", role: "ea" }));
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.teams.length, 1);
  assert.equal(result.body.teams[0].campus, "BU");
  assert.equal("email" in result.body.teams[0].participants[0], false);
});

test("staff teams still requires a signed-in interviewer", async () => {
  const result = await route.GET(request(null));
  assert.equal(result.status, 401);
  assert.equal(result.body.error, "login_required");
});

test("production staff schedule uses the staff database; staging routes stay fail-closed", () => {
  const source = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
  const teamsRoute = source("app/api/interview/staff/teams/route.ts");
  assert.match(teamsRoute, /interviewStaffDatabase\(/);
  assert.doesNotMatch(teamsRoute, /interviewDatabase\(/);
  const guard = source("lib/interview-admin-api.ts");
  assert.match(guard, /VERCEL_ENV !== "preview"/);
  assert.match(guard, /staging_only/);
  const staging = {
    "app/api/interview/admin/roster/route.ts": /interviewAdminGuard/,
    "app/api/interview/admin/operations/route.ts": /interviewAdminGuard/,
    "app/api/interview/admin/launch-review/route.ts": /interviewAdminGuard/,
    "app/api/interview/admin/founder-schedule-check/route.ts": /interviewAdminGuard/,
    "app/api/interview/booking/status/route.ts": /requireInterviewStagingBooking/,
    "app/api/interview/scheduler/route.ts": /interviewSchedulerAuthorized/,
  };
  for (const [path, gate] of Object.entries(staging)) {
    const routeSource = source(path);
    assert.match(routeSource, gate, path);
    assert.match(routeSource, /interviewDatabase\(/, path);
    assert.doesNotMatch(routeSource, /interviewStaffDatabase\(/, path);
  }
  const schedulerAuth = source("lib/interview-scheduler-auth.ts");
  assert.match(schedulerAuth, /VERCEL_ENV!=="preview"/);
  const productionScheduler = source("app/api/interview/production/scheduler/route.ts");
  assert.match(productionScheduler, /runProductionInterviewScheduler/);
  assert.doesNotMatch(productionScheduler, /interviewDatabase\(/);
});
