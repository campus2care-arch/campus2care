import test from "node:test";
import assert from "node:assert/strict";
import {loadInterviewModule} from "./interview-test-loader.mjs";

const facts = loadInterviewModule("interview-production-audience-facts");
const env = {
  VERCEL_ENV: "production",
  INTERVIEW_DATA_ENV: "production",
  INTERVIEW_PRODUCTION_APPLICANT_REVIEW_ENABLED: "true",
  INTERVIEW_NOTION_LIVE_TOKEN: "test-token-not-used-for-real-access-1234",
};

function withReviewEnv(run) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

test("campaign capacity counts lead-published slots and does not require a shadower", () => {
  const sql = facts.bookableSlotCapacitySql;
  assert.match(sql, /s\.approved_by='president@campus2care\.org'/);
  assert.match(sql, /lower\(s\.approved_by\)=lower\(i\.workspace_email\)/);
  assert.match(sql, /i\.active AND i\.weekly_capacity_limit>0/);
  assert.match(sql, /interval '40 days'/);
  assert.match(sql, /\(s\.starts_at AT TIME ZONE 'America\/New_York'\)::date>\(now\(\) AT TIME ZONE 'America\/New_York'\)::date/);
  assert.doesNotMatch(sql, /AND EXISTS \(SELECT 1 FROM interview\.schedule_participant p WHERE p\.slot_id=s\.id AND p\.role='shadow'\)/);
  assert.equal((sql.match(/\(/g) ?? []).length, (sql.match(/\)/g) ?? []).length);
});

test("BC capacity follows returned bookable slots while send approval stays outside this query", async () => {
  const queries = [];
  const db = {unsafe: async (sql) => {
    queries.push(sql);
    if (sql === facts.bookableSlotCapacitySql) return [{campus: "BC", open: 4}];
    if (sql.includes("AS outstanding")) return [{campus: "BC", outstanding: 1}];
    return [];
  }};
  const loaded = await withReviewEnv(() => facts.loadProductionAudienceFacts(db));
  assert.equal(loaded.capacityByCampus.BC, true);
  assert.equal(loaded.capacityByCampus.BU, false);
  assert.equal(loaded.remainingCapacityByCampus.BC, 3);
  assert.equal(loaded.remainingCapacityByCampus.BU, 0);
  assert.equal(queries.includes(facts.bookableSlotCapacitySql), true);
  assert.equal(queries.some(sql => sql.includes("applicant_campaign_manifest")), false);
});
