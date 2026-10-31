import test from "node:test";
import assert from "node:assert/strict";
import { loadInterviewModule } from "./interview-test-loader.mjs";

const BU = "408d6c55a9de81da9063fe9a32d88d9b";
const BC = "408d6c55a9de8164b8faf8d438c8fa71";
const EMAIL_BU = "contact+interview-canary-bu@campus2care.org";
const EMAIL_BC = "contact+interview-canary-bc@campus2care.org";
process.env.INTERVIEW_AUTH_SECRET = "secret-for-canary-tests-not-a-real-production-credential".repeat(2);

const service = loadInterviewModule("interview-production-canary-invitation", {
  "./interview-production-verification-gate": {
    productionVerificationCanaryConfig: () => ({ emailSendsApproved: process.env.INTERVIEW_PRODUCTION_VERIFICATION_SENDS_APPROVED === "true" }),
    productionVerificationCanaryDatabase: () => { throw Error("real database accessed in tests"); },
    assertProductionVerificationIdentity: (campus, email, pageId) => {
      if ((campus !== "BU" && campus !== "BC") ||
          email !== (campus === "BU" ? EMAIL_BU : EMAIL_BC) ||
          pageId !== (campus === "BU" ? BU : BC)) {
        throw Error("not_allowlisted");
      }
      return { campus, email, pageId };
    },
  },
  "./interview-production-db": {
    productionInterviewDatabase: () => { throw Error("production database accessed in tests"); },
  },
  "./interview-production-notion": {
    verifyLiveCanaryApplicant: async () => { throw Error("real Notion accessed in tests"); },
  },
});

function makeDB({ active = false, reserved = false, recent = 0 } = {}) {
  const queries = [];
  const sql = async (strings, ...params) => {
    const statement = strings.join("?");
    queries.push({ statement, params });
    if (statement.includes("FROM interview.invitation") && statement.includes("revoked_at")) {
      return active ? [{ id: "00000000-0000-0000-0000-000000000001" }] : [];
    }
    if (statement.includes("FROM interview.reservation")) {
      return reserved ? [{ id: "00000000-0000-0000-0000-000000000001" }] : [];
    }
    if (statement.includes("count(*)::int")) return [{ total: recent }];
    return [];
  };
  sql.begin = async (callback) => callback(sql);
  sql.json = (value) => value;
  return { db: sql, queries };
}

const bu = { campus: "BU", pageId: BU, email: EMAIL_BU };
const bc = { campus: "BC", pageId: BC, email: EMAIL_BC };

test("BU/BC canary issuance produces one unverified 24-hour token and zero provider writes", async () => {
  for (const input of [bu, bc]) {
    const f = makeDB();
    const now = Date.parse("2026-10-29T18:00:00Z");
    let checked = 0;
    const result = await service.issueProductionCanaryInvitation(input, {
      db: f.db, now,
      verifyApplicant: async (value) => {
        assert.deepEqual(value, input);
        checked += 1;
        return { campus: value.campus, notionPageId: value.pageId, recipientEmail: value.email };
      },
    });
    assert.equal(checked, 1);
    assert.equal(result.emailVerified, false);
    assert.equal(result.campus, input.campus);
    assert.equal(result.expiresAt, "2026-10-30T18:00:00.000Z");
    assert.match(result.invitationToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(f.queries.filter(x => x.statement.includes("INSERT INTO interview.invitation")).length, 1);
    assert.equal(f.queries.filter(x => x.statement.includes("INSERT INTO interview.applicant_contact")).length, 1);
    assert.ok(f.queries.some(x => x.statement.includes("pg_advisory_xact_lock")));
    assert.ok(f.queries.some(x => x.statement.includes("INSERT INTO interview.audit_event")));
    assert.ok(!f.queries.some(x => /INSERT INTO interview\.message|INSERT INTO interview\.integration_outbox|UPDATE interview\.invitation/.test(x.statement)));
  }
});

test("nonallowlisted identity fails before Notion or DB is accessed", async () => {
  const f = makeDB();
  await assert.rejects(service.issueProductionCanaryInvitation({
    ...bu, email: "realvolunteer@bu.edu",
  }, {
    db: f.db,
    verifyApplicant: async () => { throw Error("should not read Notion"); },
  }), /canary_identity_denied/);
  assert.equal(f.queries.length, 0);
});

test("notion-ineligible applicant cannot receive a production invitation", async () => {
  const f = makeDB();
  await assert.rejects(service.issueProductionCanaryInvitation(bu, {
    db: f.db, verifyApplicant: async () => { throw Error("notion_ineligible"); },
  }), /notion_ineligible/);
  assert.equal(f.queries.length, 0);
});

test("active invitations, bookings, and daily limit fail closed", async () => {
  for (const [state, reason] of [
    [{ active: true }, /canary_invitation_already_active/],
    [{ reserved: true }, /canary_booking_already_active/],
    [{ recent: 3 }, /canary_invitation_daily_limit/],
  ]) {
    const f = makeDB(state);
    await assert.rejects(service.issueProductionCanaryInvitation(bu, {
      db: f.db, verifyApplicant: async () => ({}),
    }), reason);
    assert.ok(!f.queries.some(x => x.statement.includes("INSERT INTO interview.invitation")));
  }
});
