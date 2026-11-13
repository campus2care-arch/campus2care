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
async function load(path) {
  return compile(await readFile(new URL(path, import.meta.url), "utf8"));
}
const scopeUrl = dataUrl(await load("../app/api/jarvis/scope.ts"));
const modelUrl = dataUrl(await load("../app/api/jarvis/research/model.ts"));
const notionUrl = dataUrl((await load("../app/api/jarvis/research/notion.ts")).replaceAll('from "./model"', `from ${JSON.stringify(modelUrl)}`));
const templateUrl = dataUrl(await load("../app/api/jarvis/banner/banner-template.ts"));
const renderUrl = dataUrl((await load("../app/api/jarvis/banner/render.ts")).replaceAll('from "../scope"', `from ${JSON.stringify(scopeUrl)}`));
const metricsUrl = dataUrl((await load("../app/api/jarvis/metrics/route.ts"))
  .replaceAll('from "../scope"', `from ${JSON.stringify(scopeUrl)}`)
  .replaceAll('from "../research/model"', `from ${JSON.stringify(modelUrl)}`)
  .replaceAll('from "../research/notion"', `from ${JSON.stringify(notionUrl)}`));
const routeUrl = dataUrl((await load("../app/api/jarvis/banner/route.ts"))
  .replaceAll('from "../scope"', `from ${JSON.stringify(scopeUrl)}`)
  .replaceAll('from "./banner-template"', `from ${JSON.stringify(templateUrl)}`)
  .replaceAll('from "./render"', `from ${JSON.stringify(renderUrl)}`)
  .replaceAll('from "../metrics/route"', `from ${JSON.stringify(metricsUrl)}`));

const { bannerHTML } = await import(templateUrl);
const { renderBanner } = await import(renderUrl);
const { parseJarvisScope, validateBannerMetrics } = await import(scopeUrl);
const { GET } = await import(routeUrl);

const updatedAt = "2026-11-13T15:00:00.000Z";
const research = {
  phase: "Protocol finalization · pre-registration",
  completed: 0,
  total: 12,
  inProgress: 0,
  confirmed: 9,
  pending: 3,
  notStarted: 12,
  submitted: 0,
  checked: 0,
};
const full = {
  totalVolunteers: 10,
  clearedVolunteers: 3,
  dueTasks: 4,
  campuses: {
    BU: { total: 6, cleared: 2 },
    BC: { total: 4, cleared: 1 },
  },
  research,
  updatedAt,
};
const bcVolunteers = {
  campus: "BC",
  metrics: ["volunteers", "cleared"],
  totalVolunteers: 4,
  clearedVolunteers: 1,
  campuses: { BC: { total: 4, cleared: 1 } },
  updatedAt,
};

function jsonBlock(html, id) {
  const match = html.match(new RegExp(`id="${id}" type="application/json">([^<]*)</script>`));
  assert.ok(match, id);
  return JSON.parse(match[1]);
}

function render(payload, requestUrl) {
  const scope = parseJarvisScope(requestUrl ? new Request(requestUrl) : undefined);
  const metrics = payload && validateBannerMetrics(payload, scope) ? payload : null;
  return renderBanner(bannerHTML, scope, metrics);
}

test("the plain banner URL still shows combined HQ counts", () => {
  const html = render(full);
  assert.match(html, /Total volunteers/);
  assert.match(html, /Cleared volunteers/);
  assert.match(html, /Tasks due/);
  assert.match(html, /Assignment 1/);
  assert.match(html, /data-metric="totalVolunteers">10/);
  assert.match(html, /data-metric="clearedVolunteers">3/);
  assert.match(html, /data-metric="dueTasks">4/);
  assert.match(html, /data-metric="researchCompleted">0/);
  assert.match(html, /id="research-total">12/);
  assert.match(html, /9 confirmed · 3 pending · not started/);
  assert.equal(html.includes('phase === "orientation"'), false);
  assert.equal(html.includes("selected ·"), false);
  assert.match(html, /const endpoint = "https:\/\/www\.campus2care\.org\/api\/jarvis\/metrics"/);
  assert.match(html, /endpoint \+ "\?refresh="/);
  assert.match(html, /data\.totalVolunteers === data\.campuses\.BU\.total \+ data\.campuses\.BC\.total/);
  assert.deepEqual(jsonBlock(html, "banner-scope"), { campus: null, metrics: null });
  const initial = jsonBlock(html, "initial-metrics");
  assert.equal(initial.totalVolunteers, 10);
  assert.equal(initial.dueTasks, 4);
  assert.equal(initial.research.completed, 0);
  assert.equal(initial.research.confirmed, 9);
  assert.equal(initial.research.total, 12);
});

test("campus and volunteer metrics show only Boston College volunteer counts", () => {
  const html = render(bcVolunteers, "https://www.campus2care.org/api/jarvis/banner?campus=BC&metrics=volunteers,cleared");
  assert.match(html, /data-metric-card="volunteers"/);
  assert.match(html, /data-metric-card="cleared"/);
  assert.equal(html.includes('data-metric-card="tasks"'), false);
  assert.equal(html.includes('data-metric-card="research"'), false);
  assert.equal(html.includes("Tasks due"), false);
  assert.equal(html.includes("Assignment 1"), false);
  assert.equal(html.includes("due tasks and research progress"), false);
  assert.match(html, /data-metric="totalVolunteers">4/);
  assert.match(html, /data-metric="clearedVolunteers">1/);
  assert.match(html, /data-count="2"/);
  assert.match(html, /Boston College total volunteers and cleared volunteers/);
  assert.match(html, /id="campus-volunteer-breakdown">Boston College/);
  assert.match(html, /<title>Jarvis · Boston College<\/title>/);
  assert.match(html, /<div class="next" hidden>/);
  assert.deepEqual(jsonBlock(html, "banner-scope"), { campus: "BC", metrics: ["volunteers", "cleared"] });
  const initial = jsonBlock(html, "initial-metrics");
  assert.equal(initial.totalVolunteers, 4);
  assert.equal(initial.clearedVolunteers, 1);
  assert.equal(initial.campuses.BC.total, 4);
  assert.equal("dueTasks" in initial, false);
  assert.equal("research" in initial, false);
  assert.match(html, /new URL\("\/api\/jarvis\/metrics", window\.location\.origin\)/);
  assert.match(html, /url\.searchParams\.set\("campus", scope\.campus\)/);
});

test("a scoped payload that still includes task or research counts is rejected", () => {
  const requestUrl = "https://www.campus2care.org/api/jarvis/banner?campus=BC&metrics=volunteers,cleared";
  const scope = parseJarvisScope(new Request(requestUrl));
  assert.equal(validateBannerMetrics({ ...bcVolunteers, dueTasks: 9, research }, scope), false);
  const html = render({ ...bcVolunteers, dueTasks: 9, research }, requestUrl);
  assert.equal(html.includes("Tasks due"), false);
  assert.equal(html.includes("Assignment 1"), false);
  assert.equal(html.includes('"dueTasks":9'), false);
  assert.equal(jsonBlock(html, "initial-metrics"), null);
});

test("unknown campus and metric values fall back to the combined banner", () => {
  const html = render(full, "https://www.campus2care.org/api/jarvis/banner?campus=NYU&metrics=not-a-metric");
  assert.match(html, /Tasks due/);
  assert.match(html, /Assignment 1/);
  assert.match(html, /data-metric="totalVolunteers">10/);
  assert.deepEqual(jsonBlock(html, "banner-scope"), { campus: null, metrics: null });
});

const titled = (value) => ({ title: [{ plain_text: value }] });
const select = (value) => ({ select: { name: value } });

test("the banner route reads scoped campus metrics without task or research queries", async () => {
  const oldFetch = globalThis.fetch;
  const oldToken = process.env.NOTION_TOKEN;
  process.env.NOTION_TOKEN = "test-token-only";
  delete process.env.RESEARCH_STATUS_DATA_SOURCE;
  const queried = [];
  globalThis.fetch = async (url) => {
    const id = String(url).match(/\/data_sources\/([^/]+)\/query/)?.[1];
    queried.push(id);
    const results = id === "c62767c6-3b89-4f45-82d5-9b8a17eb71ee" ? [
      { properties: { Volunteer: titled("BC first"), Stage: select("Cleared") } },
      { properties: { Volunteer: titled("BC second"), Stage: select("Needs Interview") } },
    ] : [{ properties: { Volunteer: titled("Should not be counted"), Stage: select("Cleared") } }];
    return Response.json({ results, has_more: false });
  };
  try {
    const response = await GET(new Request("https://www.campus2care.org/api/jarvis/banner?campus=BC&metrics=volunteers,cleared"));
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(queried, ["c62767c6-3b89-4f45-82d5-9b8a17eb71ee"]);
    assert.match(html, /data-metric="totalVolunteers">2/);
    assert.match(html, /data-metric="clearedVolunteers">1/);
    assert.equal(html.includes("Tasks due"), false);
    assert.equal(html.includes("Assignment 1"), false);
    const initial = jsonBlock(html, "initial-metrics");
    assert.equal("dueTasks" in initial, false);
    assert.equal("research" in initial, false);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = oldToken;
  }
});

test("the plain banner route still combines BU and BC and keeps task and research counts", async () => {
  const oldFetch = globalThis.fetch;
  const oldToken = process.env.NOTION_TOKEN;
  process.env.NOTION_TOKEN = "test-token-only";
  delete process.env.RESEARCH_STATUS_DATA_SOURCE;
  const queried = [];
  globalThis.fetch = async (url) => {
    const id = String(url).match(/\/data_sources\/([^/]+)\/query/)?.[1];
    queried.push(id);
    let results = [];
    if (id === "2a3fd7a6-1dcc-4b57-b394-0f8821b3a2c7") {
      results = [{ properties: { Volunteer: titled("BU"), Stage: select("Cleared") } }];
    } else if (id === "c62767c6-3b89-4f45-82d5-9b8a17eb71ee") {
      results = [{ properties: { Volunteer: titled("BC"), Stage: select("Needs Interview") } }];
    }
    return Response.json({ results, has_more: false });
  };
  try {
    const response = await GET();
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Security-Policy"), /connect-src 'self' https:\/\/www\.campus2care\.org/);
    assert.equal(queried.length, 4);
    assert.equal(queried.includes("2715ffc8-cf3e-4c01-8239-48ab03eb6988"), false);
    assert.match(html, /data-metric="totalVolunteers">2/);
    assert.match(html, /data-metric="clearedVolunteers">1/);
    assert.match(html, /data-metric="dueTasks">0/);
    assert.match(html, /Tasks due/);
    assert.match(html, /Assignment 1/);
    assert.equal(jsonBlock(html, "banner-scope").campus, null);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = oldToken;
  }
});
