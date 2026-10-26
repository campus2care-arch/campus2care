import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../app/api/jarvis/pipeline-chart/route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const GET = (await import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"))).GET;
const stages = (override = {}) => ({
  Cleared: 0, "Hospital Onboarding": 0, "Needs Interview": 0,
  "Needs Placement": 0, "Needs Workshop": 0, "No Stage": 0, ...override,
});
const sample = {
  campuses: {
    BU: {total: 211, cleared: 18, stages:stages({Cleared:18,"Hospital Onboarding":67,"Needs Interview":53,"Needs Placement":47,"Needs Workshop":18,"No Stage":8})},
    BC: {total: 7, cleared: 0, stages:stages({"Needs Interview":7})}
  },
  updatedAt:"2026-10-26T22:00:00.000Z"
};

async function render(value = sample) {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(value);
  try {
    const response = await GET();
    return {response, html: await response.text()};
  } finally {
    globalThis.fetch = oldFetch;
  }
}
test("one embeddable donut with a working BU/BC selector and both source snapshots", async () => {
  const {response, html} = await render();
  assert.equal(response.status, 200);
  assert.match(html, /id="campus"/);
  assert.match(html, /value="BU"/);
  assert.match(html, /value="BC"/);
  assert.match(html, /selector\.addEventListener\("change"/);
  assert.match(html, /"BU":\{"total":211/);
  assert.match(html, /"BC":\{"total":7/);
  assert.match(html, /Hospital Onboarding/);
  assert.equal((html.match(/class="donut"/g) || []).length, 1);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});
test("invalid metrics never inject stale or fabricated counts", async () => {
  const {response, html} = await render({campuses: {BU: {total:999}}});
  assert.equal(response.status, 200);
  assert.ok(html.includes('id="initial-data">null</script>'));
  assert.ok(!html.includes('"total":999'));
  assert.match(html, /Live data temporarily unavailable/);
});
