import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

function compile(source) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
function dataUrl(source) {
  return "data:text/javascript;base64," + Buffer.from(source).toString("base64");
}
const scopeUrl = dataUrl(compile(await readFile(new URL("../app/api/jarvis/scope.ts", import.meta.url), "utf8")));
const routeSource = await readFile(new URL("../app/api/jarvis/pipeline-chart/route.ts", import.meta.url), "utf8");
const compiled = compile(routeSource).replaceAll('from "../scope"', `from ${JSON.stringify(scopeUrl)}`);
const GET = (await import(dataUrl(compiled))).GET;
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

async function render(value = sample, requestUrl) {
  const oldFetch = globalThis.fetch;
  let fetched = "";
  globalThis.fetch = async (url) => {
    fetched = String(url);
    return Response.json(value);
  };
  try {
    const response = requestUrl ? await GET(new Request(requestUrl)) : await GET();
    return {response, html: await response.text(), fetched};
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

test("donut shows an explicit student-count tooltip on hover, focus and tap", async () => {
  const { html } = await render();
  assert.match(html, /id="stage-tooltip" role="tooltip" hidden/);
  assert.match(html, /class="tip-name" id="tip-name"/);
  assert.match(html, /class="tip-count" id="tip-count"/);
  assert.match(html, /arc\.addEventListener\("pointerenter", moveTip\)/);
  assert.match(html, /arc\.addEventListener\("pointermove", moveTip\)/);
  assert.match(html, /arc\.addEventListener\("focus", focusTip\)/);
  assert.match(html, /arc\.addEventListener\("click", moveTip\)/);
  assert.match(html, /arc\.setAttribute\("aria-label", name \+ ": " \+ count/);
  assert.match(html, /tipCount\.textContent = count\.toLocaleString\("en-US"\)/);
  assert.match(html, /tooltip\.hidden = false/);
  assert.match(html, /tooltip\.hidden = true/);
  assert.match(html, /event\.key === "Escape"/);
  assert.match(html, /selector\.addEventListener\("change"/);
  assert.match(html, /"BC":\{"total":7/);
});

test("campus=BC preselects Boston College and locks the dropdown", async () => {
  const { response, html, fetched } = await render(sample, "https://www.campus2care.org/api/jarvis/pipeline-chart?campus=BC");
  assert.equal(response.status, 200);
  assert.equal(fetched, "https://www.campus2care.org/api/jarvis/metrics");
  assert.match(html, /data-campus-lock="BC"/);
  assert.match(html, /aria-label="Boston College pipeline, locked" disabled/);
  assert.match(html, /<option value="BC" selected>Boston College \(BC\)<\/option>/);
  assert.match(html, /<span class="campus-lock">Boston College \(BC\)<\/span>/);
  assert.match(html, /data-campus-lock="BC"\] select\{display:none\}/);
  assert.match(html, /if \(campusLock === "BU" \|\| campusLock === "BC"\) return;/);
  assert.match(html, /Source: Boston College Notion pipeline/);
  assert.match(html, /"BC":\{"total":7/);
  assert.equal(html.includes("__CAMPUS"), false);
});

test("an unknown campus keeps the unlocked BU/BC dropdown", async () => {
  const { html, fetched } = await render(sample, "https://www.campus2care.org/api/jarvis/pipeline-chart?campus=NYU");
  assert.equal(fetched, "https://www.campus2care.org/api/jarvis/metrics");
  assert.match(html, /data-campus-lock=""/);
  assert.match(html, /aria-label="Select campus pipeline"><option value="BU">Boston University \(BU\)<\/option><option value="BC">Boston College \(BC\)<\/option>/);
  assert.match(html, /Source: separate BU and BC Notion pipelines/);
  assert.equal(html.includes(" disabled"), false);
  assert.equal(html.includes("__CAMPUS"), false);
});
