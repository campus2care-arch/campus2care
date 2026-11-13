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
const modelUrl = dataUrl(compile(await readFile(new URL("../app/api/jarvis/research/model.ts", import.meta.url), "utf8")));
const notionUrl = dataUrl(compile(await readFile(new URL("../app/api/jarvis/research/notion.ts", import.meta.url), "utf8")).replaceAll('from "./model"', `from ${JSON.stringify(modelUrl)}`));
const routeSource = await readFile(new URL("../app/api/jarvis/metrics/route.ts", import.meta.url), "utf8");
const compiled = compile(routeSource)
  .replaceAll('from "../scope"', `from ${JSON.stringify(scopeUrl)}`)
  .replaceAll('from "../research/model"', `from ${JSON.stringify(modelUrl)}`)
  .replaceAll('from "../research/notion"', `from ${JSON.stringify(notionUrl)}`);
const GET = (await import(dataUrl(compiled))).GET;
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

async function check(candidatesInput = candidates, teamsInput = teams, pipelineInput = [], bcPipelineInput = [], requestUrl) {
  const oldFetch = globalThis.fetch;
  const oldToken = process.env.NOTION_TOKEN;
  process.env.NOTION_TOKEN = "test-token-only";
  delete process.env.RESEARCH_STATUS_DATA_SOURCE;
  const queried = [];
  globalThis.fetch = async (url) => {
    const id = String(url).match(/\/data_sources\/([^/]+)\/query/)?.[1];
    queried.push(id);
    let results;
    if (id === "2a3fd7a6-1dcc-4b57-b394-0f8821b3a2c7") results = pipelineInput;
    else if (id === "c62767c6-3b89-4f45-82d5-9b8a17eb71ee") results = bcPipelineInput;
    else if (id === "2715ffc8-cf3e-4c01-8239-48ab03eb6988") results = candidatesInput;
    else if (id === "c1ebdb3e-649c-4c5a-9ed2-e1099ac673ce") results = teamsInput;
    else results = [];
    return Response.json({ results, has_more: false });
  };
  try {
    const response = requestUrl ? await GET(new Request(requestUrl)) : await GET();
    return { response, json: await response.json(), queried };
  } finally {
    globalThis.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = oldToken;
  }
}

const roster = (value) => ({ select: { name: value } });
const card = (value) => ({ rich_text: [{ plain_text: value }] });
const assignmentTitle = (value) => ({ title: [{ plain_text: value }] });

function assignmentRow({ title, cardId, status, rosterStatus, owner, checker, emailAddress }) {
  return { properties: {
    Assignment: assignmentTitle(title),
    Card: card(cardId),
    Status: select(status),
    "Roster Status": roster(rosterStatus),
    "Proposed Owner": text(owner),
    "Second Checker": text(checker),
    "Owner Email": email(emailAddress),
  } };
}

const assignmentRows = [
  ...["Brian", "Ricardo", "Ada", "Sophie", "Charlotte", "Katie", "Aiden", "Jenny", "Jinny"].map((name) => assignmentRow({
    title: `A1 · ${name}`, cardId: `A1-${name}`, status: "Not started", rosterStatus: "Accepted",
    owner: name, checker: "Checker", emailAddress: `${name.toLowerCase()}@example.edu`,
  })),
  ...["Cooper", "Maria", "Jolie"].map((name) => assignmentRow({
    title: `C · ${name}`, cardId: `C-${name}`, status: "Not started", rosterStatus: "Pending written acceptance",
    owner: name, checker: "Checker", emailAddress: `${name.toLowerCase()}@example.edu`,
  })),
  assignmentRow({
    title: "Leadership | verify PROSPERO", cardId: "LEAD", status: "Proposed", rosterStatus: "Leadership",
    owner: "Andrew", checker: "To appoint", emailAddress: "lead@example.edu",
  }),
];

test("assignment progress counts the twelve-person roster and leaves leadership out", async () => {
  const { response, json, queried } = await check(candidates, assignmentRows);
  assert.equal(response.status, 200);
  assert.deepEqual(json.research, {
    phase: "unset", completed: 0, total: 12, inProgress: 0,
    confirmed: 9, pending: 3, notStarted: 12, submitted: 0, checked: 0,
  });
  assert.equal(queried.includes("2715ffc8-cf3e-4c01-8239-48ab03eb6988"), false);
  const payload = JSON.stringify(json);
  assert.equal(payload.includes("@example.edu"), false);
  assert.equal(payload.includes("Internal Review Notes"), false);
  assert.equal(payload.includes("score"), false);
});

test("assignment statuses map onto not started, in progress, submitted, and checked", async () => {
  const rows = [
    assignmentRow({ title: "A1 · Brian", cardId: "A1-Brian", status: "In preparation", rosterStatus: "Accepted", owner: "Brian", checker: "Ada", emailAddress: "brian@example.edu" }),
    assignmentRow({ title: "A1 · Ada", cardId: "A1-Ada", status: "Needs supervisor review", rosterStatus: "Accepted", owner: "Ada", checker: "Brian", emailAddress: "ada@example.edu" }),
    assignmentRow({ title: "A1 · Jinny", cardId: "A1-Jinny", status: "Approved as training complete", rosterStatus: "Accepted", owner: "Jinny", checker: "Aiden", emailAddress: "jinny@example.edu" }),
    assignmentRow({ title: "A1 · Aiden", cardId: "A1-Aiden", status: "Blocked / escalation", rosterStatus: "Pending written acceptance", owner: "Aiden", checker: "Jinny", emailAddress: "aiden@example.edu" }),
    assignmentRow({ title: "Leadership | gate", cardId: "LEAD", status: "Approved as training complete", rosterStatus: "Leadership", owner: "Andrew", checker: "None", emailAddress: "lead@example.edu" }),
  ];
  const { json } = await check([], rows);
  assert.equal(json.research.total, 4);
  assert.equal(json.research.notStarted, 0);
  assert.equal(json.research.inProgress, 2);
  assert.equal(json.research.submitted, 1);
  assert.equal(json.research.checked, 1);
  assert.equal(json.research.completed, 1);
  assert.equal(json.research.confirmed, 3);
  assert.equal(json.research.pending, 1);
});

const titled = value => ({ title: [{ plain_text: value }] });
const hospitalFlag = value => ({ multi_select: [{ name: value }] });

test("JARVIS cleared count matches the Stage-based Notion donut chart, not conflicting legacy flags", async () => {
  const pipeline = [
    { properties: { Volunteer: titled("Cleared without legacy flag"), Stage: select("Cleared") } },
    { properties: { Volunteer: titled("Cleared despite old No"), Stage: select("Cleared"), "Cleared to Start by Hospital": hospitalFlag("No") } },
    { properties: { Volunteer: titled("Hospital flag Yes but still onboarding"), Stage: select("Hospital Onboarding"), "Cleared to Start by Hospital": hospitalFlag("Yes") } },
    { properties: { Volunteer: titled("Campus2Care QA Test"), Stage: select("Cleared"), "Cleared to Start by Hospital": hospitalFlag("Yes") } },
    { properties: { Volunteer: titled(""), Stage: select("Cleared"), Email: email("blank@example.invalid") } },
  ];
  const { response, json } = await check(candidates, teams, pipeline);
  assert.equal(response.status, 200);
  assert.equal(json.totalVolunteers, 3);
  assert.equal(json.clearedVolunteers, 2);
});

test("JARVIS combines only named BU and BC volunteers while preserving campus breakdown", async () => {
  const bu = [
    { properties: { Volunteer: titled("BU first"), Stage: select("Cleared") } },
    { properties: { Volunteer: titled("BU second"), Stage: select("Needs Interview") } },
    { properties: { Volunteer: titled("") } },
  ];
  const bc = [
    { properties: { Volunteer: titled("BC first"), Stage: select("Needs Interview") } },
    { properties: { Volunteer: titled("BC second"), Stage: select("Cleared") } },
    { properties: { Volunteer: titled("Campus2Care QA Test"), Stage: select("Cleared") } },
  ];
  const { response, json } = await check(candidates, teams, bu, bc);
  assert.equal(response.status, 200);
  assert.equal(json.campuses.BU.total, 2);
  assert.equal(json.campuses.BC.total, 2);
  assert.equal(json.campuses.BU.cleared, 1);
  assert.equal(json.campuses.BC.cleared, 1);
  assert.deepEqual(json.campuses.BU.stages, {
    Cleared: 1, "Hospital Onboarding": 0, "Needs Interview": 1,
    "Needs Placement": 0, "Needs Workshop": 0, "No Stage": 0,
  });
  assert.deepEqual(json.campuses.BC.stages, {
    Cleared: 1, "Hospital Onboarding": 0, "Needs Interview": 1,
    "Needs Placement": 0, "Needs Workshop": 0, "No Stage": 0,
  });
  assert.equal(json.totalVolunteers, 4);
  assert.equal(json.clearedVolunteers, 2);
  assert.equal(JSON.stringify(json).includes("BU first"), false);
});

test("unnamed and archived records are omitted; unset stage is charted as No Stage", async () => {
  const bu = [
    { properties: { Volunteer: titled("Unstaged BU") } },
    { properties: { Volunteer: titled("Withdrawn BU"), Stage: select("Needs Interview") }, archived: true },
    { properties: { Volunteer: titled("Campus2Care QA Test") } },
  ];
  const { json } = await check(candidates, teams, bu);
  assert.equal(json.totalVolunteers, 1);
  assert.equal(json.campuses.BU.stages["No Stage"], 1);
  assert.equal(json.campuses.BC.total, 0);
});

test("scoped BC volunteer metrics skip task and research queries", async () => {
  const bu = [
    { properties: { Volunteer: titled("BU first"), Stage: select("Cleared") } },
    { properties: { Volunteer: titled("BU second"), Stage: select("Needs Interview") } },
  ];
  const bc = [
    { properties: { Volunteer: titled("BC first"), Stage: select("Needs Interview") } },
    { properties: { Volunteer: titled("BC cleared"), Stage: select("Cleared") } },
  ];
  const url = "https://www.campus2care.org/api/jarvis/metrics?campus=bc&metrics=Volunteers,Cleared";
  const { response, json, queried } = await check(candidates, teams, bu, bc, url);
  assert.equal(response.status, 200);
  assert.equal(json.campus, "BC");
  assert.deepEqual(json.metrics, ["volunteers", "cleared"]);
  assert.equal(json.totalVolunteers, 2);
  assert.equal(json.clearedVolunteers, 1);
  assert.equal(json.campuses.BC.total, 2);
  assert.equal(json.campuses.BC.cleared, 1);
  assert.equal(json.campuses.BU, undefined);
  assert.equal("dueTasks" in json, false);
  assert.equal("research" in json, false);
  assert.deepEqual(queried, ["c62767c6-3b89-4f45-82d5-9b8a17eb71ee"]);
});

test("unknown campus and metric tokens fall back without fetching tasks or research", async () => {
  const bu = [{ properties: { Volunteer: titled("BU"), Stage: select("Cleared") } }];
  const bc = [{ properties: { Volunteer: titled("BC"), Stage: select("Needs Interview") } }];
  const url = "https://www.campus2care.org/api/jarvis/metrics?campus=NYU&metrics=volunteers,cleared,widgets";
  const { response, json, queried } = await check(candidates, teams, bu, bc, url);
  assert.equal(response.status, 200);
  assert.equal(json.campus, undefined);
  assert.deepEqual(json.metrics, ["volunteers", "cleared"]);
  assert.equal(json.totalVolunteers, 2);
  assert.equal(json.clearedVolunteers, 1);
  assert.equal(json.campuses.BU.total, 1);
  assert.equal(json.campuses.BC.total, 1);
  assert.equal("dueTasks" in json, false);
  assert.equal("research" in json, false);
  assert.deepEqual(queried.slice().sort(), [
    "2a3fd7a6-1dcc-4b57-b394-0f8821b3a2c7",
    "c62767c6-3b89-4f45-82d5-9b8a17eb71ee",
  ].sort());
});

test("an unrecognized metrics list keeps the combined payload", async () => {
  const url = "https://www.campus2care.org/api/jarvis/metrics?metrics=not-a-metric&campus=nope";
  const { response, json, queried } = await check(candidates, teams, [], [], url);
  assert.equal(response.status, 200);
  assert.equal(json.totalVolunteers, 0);
  assert.equal(json.clearedVolunteers, 0);
  assert.equal(json.dueTasks, 0);
  assert.equal(json.research.phase, "unset");
  assert.equal(json.research.total, 10);
  assert.equal(json.research.notStarted, 10);
  assert.equal(json.campus, undefined);
  assert.equal(json.metrics, undefined);
  assert.equal(queried.includes("2715ffc8-cf3e-4c01-8239-48ab03eb6988"), false);
  assert.equal(queried.filter((id) => id === "c1ebdb3e-649c-4c5a-9ed2-e1099ac673ce").length, 1);
});
