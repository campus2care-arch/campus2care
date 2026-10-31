import test from "node:test";
import assert from "node:assert/strict";
import { loadInterviewModule } from "./interview-test-loader.mjs";

const BU = "408d6c55a9de81da9063fe9a32d88d9b";
const EMAIL = "contact+interview-canary-bu@campus2care.org";
const ID = "11111111-1111-1111-1111-111111111111";
const TOKEN = "a".repeat(43);
const service = loadInterviewModule("interview-production-canary-verification", {
  "./interview-production-verification-gate": {
    productionVerificationCanaryConfig: () => ({ emailSendsApproved: process.env.INTERVIEW_PRODUCTION_VERIFICATION_SENDS_APPROVED === "true" }),
    productionVerificationCanaryDatabase: () => { throw Error("real database accessed in tests"); },
    assertProductionVerificationRecipient: (campus, email) => {
      if (campus !== "BU" || email !== EMAIL) throw Error("not_allowlisted");
      return email;
    },
    assertProductionVerificationIdentity: (campus, email, pageId) => {
      if (campus !== "BU" || email !== EMAIL || pageId !== BU) throw Error("not_allowlisted");
      return { campus, email, pageId };
    },
  },
  "./interview-production-db": {
    productionInterviewDatabase: () => { throw Error("real database accessed in tests"); },
  },
  "./interview-google-provider-auth": {
    googleProviderAccessToken: () => { throw Error("real provider accessed in tests"); },
  },
});

function dbFixture({ requestedAt = null, dailyCount = 0, verified = false,
  attempts = 0, accepted = true, wrongIdentity = false } = {}) {
  const calls = [];
  const row = { id: ID, campus: "BU", notion_page_id: BU,
    email: wrongIdentity ? "realapplicant@bu.edu" : EMAIL,
    email_verified_at: verified ? new Date() : null,
    verification_requested_at: requestedAt,
    verification_attempts: attempts,
    verification_hash: null };
  const state = { hash: null, attempts };
  const sql = async (strings, ...params) => {
    const q = strings.join("?");
    calls.push({ q, params });
    if (q.includes("FROM interview.invitation i")) return [row];
    if (q.includes("count(*)::int")) return [{ total: dailyCount }];
    if (q.includes("FROM interview.applicant_contact") && q.includes("verification_expires_at")) {
      return [{ verification_hash: state.hash, verification_attempts: state.attempts }];
    }
    if (q.includes("FROM interview.message") && q.includes("state='accepted'")) return accepted ? [{ id: "2".repeat(8)+"-2222-2222-2222-"+ "2".repeat(12) }] : [];
    if (q.includes("INSERT INTO interview.message")) return [{ id: "33333333-3333-3333-3333-333333333333" }];
    if (q.includes("UPDATE interview.message") && q.includes("state='accepted'")) return [{ id: "33333333-3333-3333-3333-333333333333" }];
    if (q.includes("UPDATE interview.applicant_contact") && q.includes("verification_hash=")) state.hash = params[0];
    if (q.includes("UPDATE interview.applicant_contact") && q.includes("verification_attempts=verification_attempts+1")) state.attempts++;
    return [];
  };
  sql.begin = async (callback) => callback(sql);
  return { db: sql, calls, state, row };
}

test("no outbound verification email without explicit approval", async () => {
  process.env.INTERVIEW_PRODUCTION_VERIFICATION_SENDS_APPROVED = "false";
  const f = dbFixture();
  await assert.rejects(service.requestProductionCanaryVerification(TOKEN, {
    db: f.db, deliver: async () => { throw Error("unexpected send"); },
  }), /verification_sends_not_approved/);
  assert.equal(f.calls.length, 0);
});

test("verification starts as quarantined, sends only to allowlisted address, then records acceptance", async () => {
  process.env.INTERVIEW_PRODUCTION_VERIFICATION_SENDS_APPROVED = "true";
  const f = dbFixture();
  let sent;
  const result = await service.requestProductionCanaryVerification(TOKEN, {
    db: f.db, deliver: async (input) => {
      sent = input;
      assert.equal(input.email, EMAIL);
      assert.equal(input.campus, "BU");
      assert.match(input.code, /^\d{6}$/);
      assert.ok(f.calls.some(c => c.q.includes("INSERT INTO interview.message") &&
        c.q.includes("'reconcile_required'")));
      return "gmailaccepted123";
    },
  });
  assert.deepEqual(result, { sent: true });
  assert.ok(sent.operationKey.startsWith("interview-mail:verification:"));
  assert.ok(f.state.hash);
  assert.ok(!JSON.stringify(f.calls).includes(sent.code));
  assert.ok(f.calls.some(x => x.q.includes("UPDATE interview.message SET state='accepted'")));
  assert.ok(!f.calls.some(x => x.q.includes("UPDATE interview.invitation SET email_verified_at=now()")));
});

test("unknown Gmail outcome stays quarantined and cannot be automatically resent", async () => {
  process.env.INTERVIEW_PRODUCTION_VERIFICATION_SENDS_APPROVED = "true";
  const f = dbFixture();
  await assert.rejects(service.requestProductionCanaryVerification(TOKEN, {
    db: f.db, deliver: async () => { throw Error("connection timeout"); },
  }), /verification_delivery_uncertain/);
  assert.ok(f.calls.some(c => c.q.includes("INSERT INTO interview.message")));
  assert.ok(!f.calls.some(c => c.q.includes("UPDATE interview.message SET state='accepted'")));
});

test("wrong identity, request cooldown and seven-day limit fail before any mail attempt", async () => {
  process.env.INTERVIEW_PRODUCTION_VERIFICATION_SENDS_APPROVED = "true";
  for (const [settings, pattern] of [
    [{ wrongIdentity: true }, /invalid_invitation/],
    [{ requestedAt: new Date() }, /verification_rate_limited/],
    [{ dailyCount: 3 }, /verification_daily_limit/],
  ]) {
    const f = dbFixture(settings);
    await assert.rejects(service.requestProductionCanaryVerification(TOKEN, {
      db: f.db, deliver: async () => { throw Error("unexpected send"); },
    }), pattern);
    assert.ok(!f.calls.some(c => c.q.includes("INSERT INTO interview.message")));
  }
});

test("invalid bearer token and code are rejected without DB activity", async () => {
  const f = dbFixture();
  process.env.INTERVIEW_PRODUCTION_VERIFICATION_SENDS_APPROVED = "true";
  await assert.rejects(service.requestProductionCanaryVerification("invalid", {
    db: f.db, deliver: async () => "never",
  }), /invalid_invitation/);
  await assert.rejects(service.completeProductionCanaryVerification(TOKEN,"123", {
    db: f.db,
  }), /invalid_verification/);
  assert.equal(f.calls.length, 0);
});
