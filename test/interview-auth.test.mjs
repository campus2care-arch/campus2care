import test from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../lib/interview-auth.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const auth = await import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"));
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const previousFetch = globalThis.fetch;

function jwt(claims) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sign = createSign("RSA-SHA256");
  sign.update(header + "." + body);
  return header + "." + body + "." + sign.sign(privateKey).toString("base64url");
}

const now = Date.now();
const claims = () => ({
  iss: "https://accounts.google.com",
  aud: "test-client-id", exp: Math.floor(now / 1000) + 600,
  iat: Math.floor(now / 1000) - 10, sub: "example-sub",
  email: "test.ea@campus2care.org", hd: "campus2care.org", email_verified: true,
});

test("Workspace access is an explicit EA/admin allowlist, not the whole organization", () => {
  process.env.INTERVIEW_EA_EMAILS = "test.ea@campus2care.org";
  assert.equal(auth.authorizedRole("TEST.EA@CAMPUS2CARE.ORG"), "ea");
  assert.equal(auth.authorizedRole("president@campus2care.org"), "admin");
  assert.equal(auth.authorizedRole("stranger@campus2care.org"), null);
  assert.equal(auth.authorizedRole("test.ea@gmail.com"), null);
});

test("Signed staff sessions expire and cannot be changed by clients", () => {
  process.env.INTERVIEW_AUTH_SECRET = "local-test-only-" + "x".repeat(64);
  process.env.INTERVIEW_EA_EMAILS = "test.ea@campus2care.org";
  const session = auth.makeSession("test.ea@campus2care.org", now);
  assert.deepEqual(auth.validateSession(session, now), { email: "test.ea@campus2care.org", role: "ea" });
  assert.equal(auth.validateSession(session, now + 9 * 3600 * 1000), null);
  assert.equal(auth.validateSession(session.replace(/.$/, "A"), now), null);
  assert.throws(() => auth.makeSession("nobody@campus2care.org"), /not_authorized/);
});

test("A valid Google-signed Workspace ID token is accepted; altered claims are rejected", async () => {
  process.env.INTERVIEW_GOOGLE_CLIENT_ID = "test-client-id";
  process.env.INTERVIEW_EA_EMAILS = "test.ea@campus2care.org";
  globalThis.fetch = async () => new Response(JSON.stringify({
    keys: [{ ...publicKey.export({ format: "jwk" }), kid: "test-key", use: "sig" }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    assert.equal(await auth.verifyGoogleIdToken(jwt(claims()), now), "test.ea@campus2care.org");
    await assert.rejects(auth.verifyGoogleIdToken(jwt({ ...claims(), hd: "gmail.com" }), now), /not_authorized/);
    await assert.rejects(auth.verifyGoogleIdToken(jwt({ ...claims(), email_verified: false }), now), /not_authorized/);
    await assert.rejects(auth.verifyGoogleIdToken(jwt({ ...claims(), aud: "other-client" }), now), /not_authorized/);
    await assert.rejects(auth.verifyGoogleIdToken(jwt({ ...claims(), exp: 1 }), now), /not_authorized/);
    const signed = jwt(claims());
    const changed = signed.slice(0, -5) + "abcde";
    await assert.rejects(auth.verifyGoogleIdToken(changed, now), /invalid_google_token/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
