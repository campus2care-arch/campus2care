import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../app/api/jarvis/metrics/route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const GET = (await import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"))).GET;
const select = value => ({ select: { name: value } });
const text = value => ({ rich_text: [{ plain_text: value }] });
const email = value => ({ email: value });
const currentRound = "Protocol v1.6 October 2026 candidate test round";
const selectedPrior = Array.from({ length: 9 }, (_, i) => "earlier" + i + "@example.edu");

const candidates = [
  ...selectedPrior.map(e => ({
    properties: { Email: email(e), "Stage 2 Status": select("Reviewed"), "Final Decision": select("Selected") },
  })),
  ...["jolie", "maria", "cooper"].map(e => ({
    properties: {
      Email: email(e + "@example.edu"), "Internal Review Notes": text(currentRound),
      "Stage 2 Status": select("Submitted"), "Final Decision": select("Pending"),
      "Research Participation": select("Active"),
    },
  })),
  { properties: {
    Email: email("matthew@example.edu"), "Internal Review Notes": text(currentRound),
    "Stage 2 Status": select("In Progress"), "Research Participation": select("Active"),
  } },
  { properties: {
    Email: email("anjolie@example.edu"), "Internal Review Notes": text(currentRound),
    "Stage 2 Status": select("In Progress"), "Research Participation": select("Declined"),
  } },
  { properties: { Email: email("not-selected@example.edu"), "Stage 2 Status": select("Reviewed"), "Final Decision": select("Not Selected") } },
];
const teams = [
  ...selectedPrior.map(e => ({ properties: { "Owner Email": email(e), Assignment: { title: [{ plain_text: "Proposed team preparation" }] }, Status: select("Proposed") } })),
  { properties: { "Owner Email": email("jolie@example.edu"), Assignment: { title: [{ plain_text: "Intro evidence practice" }] }, Status: select("Ready for preparatory work") } },
  { properties: { "Owner Email": email("lead@example.edu"), Assignment: { title: [{ plain_text: "Leadership | PROSPERO" }] }, Status: select("Proposed") } },
];

async function check(candidatesInput = candidates, teamsInput = teams) {
  const oldFetch = globalThis.fetch;
  const oldToken = process.env.NOTION_TOKEN;
  process.env.NOTION_TOKEN = "test-token-only";
  globalThis.fetch = async (url, options) => {
    const id = String(url).match(/\/data_sources\/([^/]+)\/query/)?.[1];
    let results;
    if (id === "2715ffc8-cf3e-4c01-8239-48ab03eb6988") results = candidatesInput;
    else if (id === "c1ebdb3e-649c-4c5a-9ed2-e1099ac673ce") results = teamsInput;
    else results = [];
    return Response.json({ results, has_more: false });
  };
  try {
    const response = await GET();
    return { response, json: await response.json() };
  } finally {
    globalThis.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = oldToken;
  }
}

test("counts nine selected originals plus three current submissions without inflating team approvals", async () => {
  const { response, json } = await check();
  assert.equal(response.status, 200);
  assert.deepEqual(json.research, {
    phase: "orientation", completed: 12, total: 13, inProgress: 1,
    selected: 9, newSubmitted: 3, awaitingReview: 3, awaitingSubmission: 1, declined: 1,
  });
  assert.equal(json.totalVolunteers, 0);
  assert.equal(json.clearedVolunteers, 0);
  assert.equal(json.dueTasks, 0);
  const payload = JSON.stringify(json);
  assert.ok(!payload.includes("@example.edu"));
  assert.ok(!payload.includes("Internal Review Notes"));
});

test("former selected students do not count without a matching current team roster row", async () => {
  const { json } = await check(candidates, teams.slice(1));
  assert.equal(json.research.selected, 8);
  assert.equal(json.research.completed, 11);
  assert.equal(json.research.total, 12);
});

test("a submitted current candidate is not counted twice when also on the team roster", async () => {
  const duplicate = { properties: {
    Email: email("jolie@example.edu"), "Stage 2 Status": select("Reviewed"), "Final Decision": select("Selected"),
  } };
  const { json } = await check([...candidates, duplicate]);
  assert.equal(json.research.total, 13);
  assert.equal(json.research.completed, 12);
});
