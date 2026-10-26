import assert from "node:assert/strict";
import { test } from "node:test";
import { loadRecovery } from "./load-route.mjs";

const payload = { submissionId: "recovery-001", universityChoice: "bc", email: "qa@example.invalid", availabilityByDay: { Monday: "9am–1pm" } };
async function setup() {
  process.env.VERCEL_ENV = "production";
  process.env.BLOB_READ_WRITE_TOKEN = "test-private-store";
  return loadRecovery();
}

test("completed receipts return the original response and never execute writes twice", async () => {
  const { withSubmission } = await setup(); let writes = 0;
  const work = async () => ({ ok: true, id: ++writes });
  assert.equal((await withSubmission("application", payload, work)).status, 200);
  assert.deepEqual(await (await withSubmission("application", payload, work)).json(), { ok: true, id: 1 });
  assert.equal(writes, 1);
});

test("receipt fingerprint includes nested day values and ignores key ordering", async () => {
  const { withSubmission } = await setup();
  await withSubmission("application", payload, async () => ({ ok: true }));
  const reversed = Object.fromEntries(Object.entries(payload).reverse());
  assert.equal((await withSubmission("application", reversed, async () => assert.fail())).status, 200);
  const changed = { ...payload, availabilityByDay: { Monday: "2pm–6pm" } };
  assert.equal((await withSubmission("application", changed, async () => assert.fail())).status, 409);
});

test("concurrent retries and different IDs for the same campus cannot race Notion creates", async () => {
  const { withSubmission, pendingSubmissions } = await setup();
  let release, entered; const barrier = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; }); let writes = 0;
  const first = withSubmission("application", payload, async () => { writes++; entered(); await barrier; return { ok: true }; });
  await started;
  assert.equal((await withSubmission("application", payload, async () => assert.fail())).status, 503);
  const other = { ...payload, submissionId: "another-id" };
  assert.equal((await withSubmission("application", other, async () => assert.fail())).status, 503);
  release(); assert.equal((await first).status, 200);
  assert.equal((await pendingSubmissions()).pending.length, 1);
  assert.equal((await withSubmission("application", other, async () => ({ ok: true }))).status, 200);
  assert.equal(writes, 1);
});

test("a failed Notion query retains the full receipt for successful retry", async () => {
  const { withSubmission, pendingSubmissions } = await setup();
  const failed = await withSubmission("application", payload, async () => { throw new Error("notion_503"); });
  assert.equal(failed.status, 503); assert.equal((await failed.json()).recoverable, true);
  assert.deepEqual((await pendingSubmissions()).pending[0].payload, payload);
  assert.equal((await withSubmission("application", payload, async () => ({ ok: true }))).status, 200);
  assert.equal((await pendingSubmissions()).pending.length, 0);
});

test("uncertain create outcomes are held for reconciliation instead of blindly replayed", async () => {
  const { withSubmission, pendingSubmissions } = await setup();
  await withSubmission("application", payload, async checkpoint => {
    await checkpoint("creating_pipeline"); throw new Error("connection lost with private applicant text");
  });
  const retry = await withSubmission("application", payload, async () => assert.fail());
  assert.equal(retry.status, 503); assert.equal((await retry.json()).error, "reconciliation_required");
  assert.equal((await pendingSubmissions()).pending.length, 0);
});

test("unavailable durable storage prevents acceptance and preview never uses production storage", async () => {
  const { withSubmission, safeError } = await setup();
  delete process.env.BLOB_READ_WRITE_TOKEN;
  assert.equal((await withSubmission("application", payload, async () => assert.fail())).status, 503);
  assert.equal(safeError(new Error("private-name@example.edu https://secret.test")), "upstream_failure");
  process.env.VERCEL_ENV = "preview";
  assert.equal((await withSubmission("application", payload, async () => ({ ok: true }))).status, 200);
});
