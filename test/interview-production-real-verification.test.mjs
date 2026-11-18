import test from "node:test";
import assert from "node:assert/strict";
import { loadInterviewModule } from "./interview-test-loader.mjs";

const BU_FIXTURE = "contact+interview-canary-bu@campus2care.org";
const BC_FIXTURE = "contact+interview-canary-bc@campus2care.org";
const TOKEN = "a".repeat(43);
const ID = "11111111-1111-4111-8111-111111111111";
const PAGE = "408d6c55a9de81da9063fe9a32d88d9b";

const gate = loadInterviewModule("interview-production-verification-gate");
const verification = loadInterviewModule("interview-production-real-verification", {
  "./interview-production-launch": {
    productionRealConfig() { return { mode: "live" }; },
    assertProductionBookingIdentity(campus, email, pageId) {
      return { campus, email, pageId };
    },
  },
  "./interview-production-db": {
    productionInterviewDatabase() { throw new Error("real database accessed in tests"); },
  },
  "./interview-production-providers": {
    productionGoogleAccessToken: async () => "unit-test-token",
  },
});

function dbFixture(email, campus = "BU") {
  const calls = [];
  const row = {
    id: ID, campus, notion_page_id: PAGE, email,
    email_verified_at: null, verification_requested_at: null,
    verification_attempts: 0, verification_hash: null,
  };
  const sql = async (strings, ...params) => {
    const q = strings.join("?");
    calls.push({ q, params });
    if (q.includes("FROM interview.invitation i")) return [row];
    if (q.includes("count(*)::int")) return [{ total: 0 }];
    if (q.includes("INSERT INTO interview.message")) {
      return [{ id: "33333333-3333-4333-8333-333333333333" }];
    }
    if (q.includes("UPDATE interview.message") && q.includes("state='accepted'")) {
      return [{ id: "33333333-3333-4333-8333-333333333333" }];
    }
    return [];
  };
  sql.begin = async (callback) => callback(sql);
  return { db: sql, calls };
}

test("live-test fixture addresses are allowed and other canary aliases are rejected", () => {
  assert.equal(gate.liveTestFixture("BU").email, BU_FIXTURE);
  assert.equal(gate.liveTestFixture("BC").email, BC_FIXTURE);
  assert.equal(verification.isAllowedVerificationRecipient("BU", BU_FIXTURE), true);
  assert.equal(verification.isAllowedVerificationRecipient("BC", BC_FIXTURE), true);
  assert.equal(verification.isAllowedVerificationRecipient("BU", "  Contact+Interview-Canary-BU@Campus2Care.org "), true);
  assert.equal(verification.isAllowedVerificationRecipient("BC", "contact+interview-canary-other@campus2care.org"), false);
  assert.equal(verification.isAllowedVerificationRecipient("BU", "person+interview-canary-bu@campus2care.org"), false);
  assert.equal(verification.isAllowedVerificationRecipient("BC", BU_FIXTURE), false);
  assert.equal(verification.isAllowedVerificationRecipient("BU", "applicant@bu.edu"), true);
  assert.equal(verification.isAllowedVerificationRecipient("BC", "applicant+lab@bc.edu"), true);
  assert.equal(verification.isAllowedVerificationRecipient("BU", "not-an-email"), false);
  assert.equal(verification.isAllowedVerificationRecipient("XX", BU_FIXTURE), false);
});

test("direct send accepts both fixtures and a normal address, and rejects a stray canary alias", async () => {
  process.env.INTERVIEW_REAL_VERIFICATION_SENDS_APPROVED = "true";
  const transport = async () => ({ ok: true, json: async () => ({ id: "gmailMsg123" }) });
  for (const [campus, email] of [
    ["BU", BU_FIXTURE],
    ["BC", BC_FIXTURE],
    ["BU", "applicant@bu.edu"],
  ]) {
    const id = await verification.sendProductionRealVerificationEmail({
      email, campus, code: "123456", operationKey: "interview-mail:verification:unit-test",
    }, transport);
    assert.equal(id, "gmailMsg123");
  }
  let called = false;
  await assert.rejects(verification.sendProductionRealVerificationEmail({
    email: "contact+interview-canary-other@campus2care.org",
    campus: "BU", code: "123456", operationKey: "interview-mail:verification:unit-test",
  }, async () => { called = true; throw new Error("should not send"); }), (error) => {
    assert.equal(error.code, "real_verification_recipient_invalid");
    assert.equal(error.status, 403);
    return true;
  });
  assert.equal(called, false);
});

test("rejected canary addresses never create a quarantined verification message", async () => {
  process.env.INTERVIEW_REAL_VERIFICATION_SENDS_APPROVED = "true";
  const f = dbFixture("contact+interview-canary-other@campus2care.org");
  await assert.rejects(verification.requestProductionRealVerification(TOKEN, {
    db: f.db, deliver: async () => { throw new Error("unexpected send"); },
  }), (error) => {
    assert.equal(error.code, "real_verification_recipient_invalid");
    assert.equal(error.status, 403);
    return true;
  });
  assert.ok(f.calls.some((call) => call.q.includes("FROM interview.invitation i")));
  assert.ok(!f.calls.some((call) => call.q.includes("INSERT INTO interview.message")));
  assert.ok(!f.calls.some((call) => call.q.includes("verification_hash=")));
});

test("typed verification errors pass through and unknown delivery errors stay uncertain", async () => {
  process.env.INTERVIEW_REAL_VERIFICATION_SENDS_APPROVED = "true";
  const rejected = new verification.ProductionRealVerificationError("real_verification_recipient_invalid", 403);
  const masked = dbFixture("applicant@bu.edu");
  await assert.rejects(verification.requestProductionRealVerification(TOKEN, {
    db: masked.db, deliver: async () => { throw rejected; },
  }), (error) => {
    assert.equal(error, rejected);
    assert.equal(error.status, 403);
    return true;
  });
  assert.ok(masked.calls.some((call) => call.q.includes("INSERT INTO interview.message")));
  assert.ok(!masked.calls.some((call) => call.q.includes("state='accepted'")));

  const uncertain = dbFixture(BU_FIXTURE);
  await assert.rejects(verification.requestProductionRealVerification(TOKEN, {
    db: uncertain.db, deliver: async () => { throw new Error("socket hang up"); },
  }), (error) => {
    assert.equal(error.name, "ProductionRealVerificationError");
    assert.equal(error.code, "verification_delivery_uncertain");
    assert.equal(error.status, 503);
    return true;
  });
  assert.ok(uncertain.calls.some((call) => call.q.includes("INSERT INTO interview.message")));
  assert.ok(!uncertain.calls.some((call) => call.q.includes("state='accepted'")));
});

test("fixture and ordinary recipients still receive a code after the message is quarantined", async () => {
  process.env.INTERVIEW_REAL_VERIFICATION_SENDS_APPROVED = "true";
  for (const email of [BU_FIXTURE, BC_FIXTURE, "applicant@bu.edu"]) {
    const campus = email === BC_FIXTURE ? "BC" : "BU";
    const f = dbFixture(email, campus);
    let sent;
    const result = await verification.requestProductionRealVerification(TOKEN, {
      db: f.db, deliver: async (input) => {
        sent = input;
        assert.equal(input.email, email);
        assert.equal(input.campus, campus);
        assert.ok(f.calls.some((call) => call.q.includes("INSERT INTO interview.message") &&
          call.q.includes("'reconcile_required'")));
        return "gmailaccepted123";
      },
    });
    assert.deepEqual(result, { sent: true });
    assert.match(sent.code, /^\d{6}$/);
    assert.ok(!JSON.stringify(f.calls).includes(sent.code));
    assert.ok(f.calls.some((call) => call.q.includes("UPDATE interview.message SET state='accepted'")));
  }
});
