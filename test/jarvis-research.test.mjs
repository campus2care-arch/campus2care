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

const modelUrl = dataUrl(await load("../app/api/jarvis/research/model.ts"));
const notionUrl = dataUrl((await load("../app/api/jarvis/research/notion.ts")).replaceAll('from "./model"', `from ${JSON.stringify(modelUrl)}`));
const metricsUrl = dataUrl((await load("../app/api/jarvis/research/metrics/route.ts")).replaceAll('from "../notion"', `from ${JSON.stringify(notionUrl)}`));
const templateUrl = dataUrl(await load("../app/api/jarvis/banner/banner-template.ts"));
const renderUrl = dataUrl((await load("../app/api/jarvis/research/render.ts"))
  .replaceAll('from "../banner/banner-template"', `from ${JSON.stringify(templateUrl)}`)
  .replaceAll('from "./model"', `from ${JSON.stringify(modelUrl)}`));
const routeUrl = dataUrl((await load("../app/api/jarvis/research/route.ts"))
  .replaceAll('from "./metrics/route"', `from ${JSON.stringify(metricsUrl)}`)
  .replaceAll('from "./model"', `from ${JSON.stringify(modelUrl)}`)
  .replaceAll('from "./render"', `from ${JSON.stringify(renderUrl)}`));

const { GET } = await import(routeUrl);
const { buildResearchPanel, summarizeAssignments } = await import(modelUrl);

const select = (value) => ({ select: { name: value } });
const text = (value) => ({ rich_text: [{ plain_text: value }] });
const titled = (value) => ({ title: [{ plain_text: value }] });
const ASSIGNMENTS = "c1ebdb3e-649c-4c5a-9ed2-e1099ac673ce";
const METHODS = "815aed83-1be3-42bf-836d-3e978e0306ce";
const DELIVERABLES = "417d6c55-a9de-8150-821d-000bdb691c3d";
const UPDATES = "417d6c55-a9de-8190-bf3b-000b2a6e76e9";
const STATUS = "11111111-1111-4111-8111-111111111111";

function assignment({ card, owner, checker, status, roster, emailAddress }) {
  return { properties: {
    Assignment: titled(`A1 · ${owner}`),
    Card: text(card),
    Status: select(status),
    "Roster Status": select(roster),
    "Proposed Owner": text(owner),
    "Second Checker": text(checker),
    "Owner Email": { email: emailAddress },
  } };
}

const accepted = ["Brian Yun", "Ricardo Calderon", "Ada Muqqadus", "Sophie Strickler", "Charlotte Sirota", "Katie (Katherine) Wellenius", "Aiden Hwang", "Jenny (Jennifer) Khuong", "Jinny Lee"];
const pending = ["Cooper Szeremeta", "Maria Pezino", "Jolie (Jolinada) Zhang"];
const assignments = [
  ...accepted.map((owner) => assignment({
    card: `A1-${owner.split(" ")[0]}`, owner, checker: "Second reader", status: "Not started", roster: "Accepted",
    emailAddress: `${owner.split(" ")[0].toLowerCase()}@example.edu`,
  })),
  ...pending.map((owner) => assignment({
    card: `C-${owner.split(" ")[0]}`, owner, checker: "Second reader", status: "Not started", roster: "Pending written acceptance",
    emailAddress: `${owner.split(" ")[0].toLowerCase()}@example.edu`,
  })),
  assignment({
    card: "LEAD", owner: "Andrew Makar", checker: "To appoint", status: "Proposed", roster: "Leadership",
    emailAddress: "founder@example.edu",
  }),
];
const gate = [
  ...Array.from({ length: 38 }, () => ({ properties: { Status: select("Not started"), "Gate Item": titled("Item") } })),
  { properties: { Status: select("Complete"), "Gate Item": titled("Done") } },
  { properties: { Status: select("Not applicable (approved)"), "Gate Item": titled("Skipped") } },
];
const statusRow = { properties: {
  Name: titled("Current"),
  Phase: text("Protocol finalization · pre-registration"),
  PROSPERO: text("Unresolved"),
  "Next action": text("Answer founder sheet; run PROSPERO check"),
  Blockers: text("PROSPERO existing-record check not done\nQuiz score 95/100\nGuarantor, authors, funding, COI unconfirmed"),
}};
const deliverables = [
  { properties: { Document: titled("Founder sheet"), Status: select("Needs Andrew decision") } },
  { properties: { Document: titled("Kickoff"), Status: select("Draft email: NOT SENT") } },
];
const updates = [
  { created_time: "2026-11-13T20:00:00.000Z", properties: { Update: titled("Assignment score 9/10"), Logged: { created_time: "2026-11-13T20:00:00.000Z" } } },
  { created_time: "2026-11-13T18:00:00.000Z", properties: { Update: titled("PROSPERO status unresolved; guarantor still open"), Logged: { created_time: "2026-11-13T18:00:00.000Z" } } },
];

async function withFetch(pagesById, run, statuses = {}) {
  const oldFetch = globalThis.fetch;
  const oldToken = process.env.NOTION_TOKEN;
  const oldStatus = process.env.RESEARCH_STATUS_DATA_SOURCE;
  process.env.NOTION_TOKEN = "test-token-only";
  process.env.RESEARCH_STATUS_DATA_SOURCE = STATUS;
  const queried = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    const id = href.match(/\/data_sources\/([^/]+)/)?.[1];
    queried.push(id || href);
    if (statuses[id]) return new Response("denied", { status: statuses[id] });
    return Response.json({ results: pagesById[id] ?? [], has_more: false });
  };
  try {
    return await run(queried);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = oldToken;
    if (oldStatus === undefined) delete process.env.RESEARCH_STATUS_DATA_SOURCE;
    else process.env.RESEARCH_STATUS_DATA_SOURCE = oldStatus;
  }
}

const pages = {
  [ASSIGNMENTS]: assignments,
  [METHODS]: gate,
  [DELIVERABLES]: deliverables,
  [UPDATES]: updates,
  [STATUS]: [statusRow],
};

test("the research panel renders live roster counts without grades, scores, or emails", async () => {
  await withFetch(pages, async () => {
    const response = await GET();
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.match(response.headers.get("Content-Security-Policy"), /frame-ancestors https:\/\/app\.notion\.com/);
    assert.match(html, /Leadership operations · Jarvis/);
    assert.match(html, />LIVE</);
    assert.match(html, /Protocol finalization · pre-registration/);
    assert.match(html, /id="gate-value">2\/40/);
    assert.match(html, /id="team-value">9/);
    assert.match(html, /3 pending acceptance/);
    assert.match(html, /id="assignment-value">0\/12/);
    assert.match(html, /12 not started · 0 in progress · 0 submitted · 0 checked/);
    assert.match(html, /id="prospero-value"[^>]*>Unresolved/);
    assert.match(html, /Jenny Khuong/);
    assert.match(html, /Katie Wellenius/);
    assert.match(html, /Jolie Zhang/);
    assert.match(html, /Checker Second reader · Not started/);
    assert.match(html, /PROSPERO existing-record check not done/);
    assert.match(html, /Guarantor, authors, funding, COI unconfirmed/);
    assert.equal(html.includes("95/100"), false);
    assert.equal(html.includes("9/10"), false);
    assert.match(html, /No grades or scores/);
    assert.equal(html.includes("@example.edu"), false);
    assert.equal(html.includes("founder@example.edu"), false);
    assert.equal(html.includes("LEAD"), false);
    assert.match(html, /Answer founder sheet; run PROSPERO check/);
    assert.match(html, /Deliverables · 1 need a decision · 1 drafts/);
    assert.match(html, /Latest · PROSPERO status unresolved; guarantor still open/);
    assert.match(html, /Updated \d{1,2}:\d{2} [AP]M ET/);
    assert.match(html, /setInterval\(refresh, 30000\)/);
    assert.equal(html.includes("innerHTML"), false);
    assert.match(html, /--red:#e30613/);
  });
});

test("a methods-gate, deliverables, or updates denial stays on that tile", async () => {
  await withFetch(pages, async () => {
    const response = await GET();
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /id="gate-value">—/);
    assert.match(html, /id="gate-detail">No access/);
    assert.match(html, /id="team-value">9/);
    assert.match(html, /id="assignment-value">0\/12/);
    assert.match(html, /Deliverables · no access/);
    assert.match(html, /Updates · no access/);
    assert.match(html, /Share with the Availability Form integration: Methods Gate Items \(v1\.6\), Research Deliverables, Research Updates/);
    assert.equal(html.includes("@example.edu"), false);
  }, { [METHODS]: 404, [DELIVERABLES]: 403, [UPDATES]: 401 });
});

test("missing Notion credentials do not fail the whole panel", async () => {
  const oldToken = process.env.NOTION_TOKEN;
  const oldStatus = process.env.RESEARCH_STATUS_DATA_SOURCE;
  delete process.env.NOTION_TOKEN;
  delete process.env.RESEARCH_STATUS_DATA_SOURCE;
  try {
    const response = await GET();
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /id="team-detail">No access/);
    assert.match(html, /id="gate-detail">No access/);
    assert.match(html, /Phase not set/);
    assert.match(html, /RESEARCH_STATUS_DATA_SOURCE/);
    assert.match(html, /Live connection pending/);
  } finally {
    if (oldToken === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = oldToken;
    if (oldStatus === undefined) delete process.env.RESEARCH_STATUS_DATA_SOURCE;
    else process.env.RESEARCH_STATUS_DATA_SOURCE = oldStatus;
  }
});

test("a database id for Research Status resolves to its data source", async () => {
  const databaseId = "22222222-2222-4222-8222-222222222222";
  const sourceId = "33333333-3333-4333-8333-333333333333";
  const oldFetch = globalThis.fetch;
  const oldToken = process.env.NOTION_TOKEN;
  const oldStatus = process.env.RESEARCH_STATUS_DATA_SOURCE;
  process.env.NOTION_TOKEN = "test-token-only";
  process.env.RESEARCH_STATUS_DATA_SOURCE = databaseId;
  const seen = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    seen.push(href);
    if (href.includes(`/databases/${databaseId}`)) {
      return Response.json({ data_sources: [{ id: sourceId }] });
    }
    const id = href.match(/\/data_sources\/([^/]+)/)?.[1];
    if (id === databaseId) return new Response("missing", { status: 404 });
    if (id === sourceId) return Response.json({ results: [statusRow], has_more: false });
    if (id === ASSIGNMENTS) return Response.json({ results: assignments, has_more: false });
    return Response.json({ results: [], has_more: false });
  };
  try {
    const response = await GET();
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /Protocol finalization · pre-registration/);
    assert.equal(seen.some((url) => url.includes(`/databases/${databaseId}`)), true);
    assert.equal(seen.some((url) => url.includes(`/data_sources/${sourceId}/query`)), true);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = oldToken;
    if (oldStatus === undefined) delete process.env.RESEARCH_STATUS_DATA_SOURCE;
    else process.env.RESEARCH_STATUS_DATA_SOURCE = oldStatus;
  }
});

test("assignment summary drops leadership, emails, and maps blocked work", () => {
  const rows = [
    ...assignments,
    assignment({
      card: "A1-Blocked", owner: "secret@example.edu", checker: "Ada Muqqadus (light read) → backup",
      status: "Blocked / escalation", roster: "Accepted", emailAddress: "secret@example.edu",
    }),
  ];
  const snapshot = summarizeAssignments(rows);
  assert.equal(snapshot.total, 13);
  assert.equal(snapshot.people.some((person) => person.card === "LEAD"), false);
  assert.equal(snapshot.people.some((person) => person.owner.includes("@")), false);
  assert.equal(snapshot.blocked.length, 1);
  assert.match(snapshot.blocked[0], /^Blocked: Team member$/);
  const blocked = snapshot.people.find((person) => person.card === "A1-Blocked");
  assert.equal(blocked.checker, "Ada Muqqadus");
  assert.equal(blocked.label, "Blocked");
  const panel = buildResearchPanel({
    updatedAt: "2026-11-13T21:00:00.000Z",
    assignments: { access: "ok", pages: rows },
    methodsGate: { access: "no-access", pages: [] },
    status: { access: "not-configured", pages: [] },
    deliverables: { access: "ok", pages: deliverables },
    updates: { access: "ok", pages: updates },
  });
  assert.equal(panel.phase.text, null);
  assert.equal(panel.blockers.items.includes("Blocked: Team member"), true);
  assert.equal(panel.share.includes("Methods Gate Items (v1.6)"), true);
  assert.equal(JSON.stringify(panel).includes("@"), false);
});
