import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

const applicationSource = await readFile(new URL("../app/api/application/route.ts", import.meta.url), "utf8");
const availabilitySource = await readFile(new URL("../app/api/availability/route.ts", import.meta.url), "utf8");
const applicationUi = await readFile(new URL("../app/application/page.tsx", import.meta.url), "utf8");
const availabilityUi = await readFile(new URL("../app/availability/page.tsx", import.meta.url), "utf8");
const toJs = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const modules = { application: toJs(applicationSource), availability: toJs(availabilitySource) };
const IDS = {
  buP: "03192649741442fe86acdddcc7320798",
  buA: "70a49d16d3474eb8af9204a6404f6af3",
  bcP: "bc8eaec9a5d449cd87426e8613299a93",
  bcA: "31524183bec6431ba82fc4b79114286b",
};
let num = 0;
async function load(route, env = "production") {
  Object.assign(process.env, {
    VERCEL_ENV: env,
    NOTION_TOKEN: "production-test-token",
    NOTION_PREVIEW_TOKEN: "preview-test-token",
    NOTION_PIPELINE_DATABASE_ID: "qa-pipeline",
    NOTION_AVAILABILITY_DATABASE_ID: "qa-availability",
    SHEET_WEBHOOK_URL: "",
  });
  return (await import("data:text/javascript;base64," +
    Buffer.from(modules[route]).toString("base64") + "#" + ++num)).POST;
}
const days = Object.fromEntries([
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
].map((day) => [day, day === "Monday" ? "9am–1pm" : "Unavailable"]));
const application = {
  submissionId: "application-qa-001", fullName: "QA Student", email: "qa@example.edu",
  phone: "6175550123", school: "Boston University", universityChoice: "bu",
  graduationYear: 2029, major: "Biology", clinicalCertification: "No",
  priorClinicalExperience: "No", comfortableWithPatients: "Yes",
  preferredStartDate: "2026-11-01", weeklyCommitmentHours: 8,
  motivation: "Support patient wellbeing", referralSource: "Website",
  totalHours: 4, longestWeekdayBlockHours: 4, meetsWeekdayBlock: true,
  availabilityByDay: days,
};
const availability = {
  submissionId: "availability-qa-001", name: "QA Student", email: "qa@example.edu",
  universityChoice: "bu", totalHours: 4, longestWeekdayBlockHours: 4,
  meetsWeekdayBlock: true, availabilityByDay: days,
};
const request = (route, body) => new Request("https://campus2care.test/api/" + route, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json" },
});
function row(id, email = "qa@example.edu") {
  return { id, properties: {
    Volunteer: { title: [{ plain_text: "QA Student" }] }, Email: { email },
    "Alternate Email": { email: null }, "Application Submission ID": { rich_text: [] },
    "Executive Associate Owner": { select: { name: "Unassigned" } },
    "Workflow Status": { select: { name: "Application Received" } },
    "Application Source": { select: { name: "Website Application" } },
  } };
}
function profile(id, pipelineId = "bc-person", email = "qa@example.edu") {
  return { id, properties: {
    Email: { email }, "Volunteer Record": { relation: [{ id: pipelineId }] },
    Superseded: { checkbox: false },
  } };
}
async function mocked({ pipelineRows = [], availabilityQueries, failPatchId } = {}, fn) {
  const prior = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : {};
    const call = { path, method: init.method, body, auth: init.headers?.Authorization };
    calls.push(call);
    if (path.endsWith("/query") && path.includes("/databases/")) {
      if (path.includes("pipeline")) return json({ results: pipelineRows, has_more: false });
      if (path.includes(IDS.buP) || path.includes(IDS.bcP)) return json({ results: pipelineRows, has_more: false });
      if (availabilityQueries) return json({ results: availabilityQueries(body, path), has_more: false });
      return json({ results: [], has_more: false });
    }
    if (path === "/v1/pages" && init.method === "POST") {
      const id = [IDS.buP, IDS.bcP, "qa-pipeline"].includes(body.parent.database_id)
        ? "created-pipeline" : "created-availability";
      return json({ id });
    }
    if (path.startsWith("/v1/pages/") && init.method === "PATCH") {
      if (failPatchId && path.endsWith(failPatchId)) return json({ message: "temporary failure" }, 500);
      return json({ id: path.split("/").at(-1) });
    }
    throw new Error("Unexpected network call: " + path);
  };
  try { return await fn(calls); } finally { globalThis.fetch = prior; }
}
const paths = (calls, target) => calls.filter((call) => call.path.includes(target));
const creates = (calls) => calls.filter((call) => call.path === "/v1/pages" && call.method === "POST");

test("both public forms expose the same required, controlled three-campus selector", () => {
  for (const source of [applicationUi, availabilityUi]) {
    for (const value of ['value="bu"', 'value="bc"', 'value="other"']) assert.ok(source.includes(value));
    assert.match(source, /Select your university/);
  }
});

test("BC application uses only BC pipeline and BC availability with a BC relation", async () =>
  mocked({}, async (calls) => {
    const post = await load("application");
    const response = await post(request("application", { ...application,
      universityChoice: "bc", school: "Boston College" }));
    assert.equal(response.status, 200);
    assert.equal(creates(calls).length, 2);
    assert.deepEqual(creates(calls).map((call) => call.body.parent.database_id), [IDS.bcP, IDS.bcA]);
    assert.deepEqual(creates(calls)[1].body.properties["Volunteer Record"].relation, [{ id: "created-pipeline" }]);
    assert.equal(creates(calls)[0].body.properties["Executive Associate Owner"].select.name, "Allison", "BC begins its own placeholder EA rotation with the BU roster");
    assert.equal(creates(calls)[0].body.properties.Stage.select.name, "Needs Interview");
    assert.equal(creates(calls)[0].body.properties["Next Step"].select.name, "Schedule interview");
    assert.equal(creates(calls)[0].body.properties["Interview Status"].select.name, "Not Scheduled");
    assert.equal(paths(calls, IDS.buP).length + paths(calls, IDS.buA).length, 0);
  }));

test("BC placeholder EA rotation advances within BC records without reading BU owners", async () =>
  mocked({ pipelineRows: [{
    ...row("bc-previous", "previous@example.edu"),
    created_time: "2026-10-25T12:00:00Z",
    properties: {
      ...row("bc-previous", "previous@example.edu").properties,
      "Executive Associate Owner": { select: { name: "Allison" } },
      "Application Source": { select: { name: "Website Application" } },
    },
  }] }, async (calls) => {
    const post = await load("application");
    const response = await post(request("application", {
      ...application, universityChoice: "bc", school: "Boston College",
    }));
    assert.equal(response.status, 200);
    assert.equal(creates(calls)[0].body.parent.database_id, IDS.bcP);
    assert.equal(creates(calls)[0].body.properties["Executive Associate Owner"].select.name, "Anjolie");
    assert.equal(paths(calls, IDS.buP).length, 0);
  }));

test("BU, Other, and legacy application submissions remain in the BU databases", async () => {
  for (const extra of [
    { universityChoice: "bu", school: "Boston University" },
    { universityChoice: "other", school: "Northeastern University" },
    { universityChoice: undefined, school: "Boston University" },
  ]) await mocked({}, async (calls) => {
    const post = await load("application");
    const response = await post(request("application", { ...application, ...extra }));
    assert.equal(response.status, 200);
    assert.deepEqual(creates(calls).map((call) => call.body.parent.database_id), [IDS.buP, IDS.buA]);
    assert.equal(creates(calls)[0].body.properties.School.rich_text[0].text.content, extra.school);
    assert.equal(paths(calls, IDS.bcP).length + paths(calls, IDS.bcA).length, 0);
  });
});

test("invalid combinations never enter BU or BC application databases", async () =>
  mocked({}, async (calls) => {
    const post = await load("application");
    for (const extra of [
      { universityChoice: "other", school: "Boston College" },
      { universityChoice: "other", school: "Boston College (Chestnut Hill)" },
      { universityChoice: "bc", school: "Boston University" },
      { universityChoice: "bu", school: "Boston College" },
      { universityChoice: "other", school: "BC" },
      { universityChoice: "not-a-school", school: "Boston University" },
      { universityChoice: undefined, school: "Boston College" },
      { universityChoice: "bc", school: undefined },
    ]) {
      const response = await post(request("application", { ...application, ...extra }));
      assert.equal(response.status, 400);
    }
    assert.equal(calls.length, 0);
  }));

test("BC availability writes solely to BC profiles and never to legacy BU Sheet", async () =>
  mocked({ pipelineRows: [row("bc-person")] }, async (calls) => {
    const post = await load("availability");
    const response = await post(request("availability", { ...availability, universityChoice: "bc" }));
    assert.equal(response.status, 200);
    assert.equal(creates(calls).length, 1);
    assert.equal(creates(calls)[0].body.parent.database_id, IDS.bcA);
    assert.deepEqual(creates(calls)[0].body.properties["Volunteer Record"].relation, [{ id: "bc-person" }]);
    assert.equal(paths(calls, IDS.buP).length + paths(calls, IDS.buA).length, 0);
    assert.equal(calls.some((call) => call.path.includes("/exec")), false);
  }));

test("BU, Other and legacy availability use BU, while preserving original university in notes", async () => {
  for (const extra of [
    { universityChoice: "bu" },
    { universityChoice: "other", otherUniversity: "Northeastern University" },
    { universityChoice: undefined },
  ]) await mocked({}, async (calls) => {
    const post = await load("availability");
    const response = await post(request("availability", { ...availability, ...extra }));
    assert.equal(response.status, 200);
    assert.deepEqual(creates(calls).map((call) => call.body.parent.database_id), [IDS.buA]);
    assert.equal(paths(calls, IDS.bcA).length, 0);
    if (extra.universityChoice === "other") assert.match(creates(calls)[0].body.properties["Availability Notes"].rich_text[0].text.content, /Northeastern University/);
  });
});

test("availability rejects spoofed school, invalid email, and missing days without writing", async () =>
  mocked({}, async (calls) => {
    const post = await load("availability");
    for (const extra of [
      { universityChoice: "invalid" },
      { universityChoice: "other", otherUniversity: "Boston College" },
      { universityChoice: "other", otherUniversity: 42 },
      { email: "not-email" },
      { availabilityByDay: { Monday: "2–3pm" } },
      { submissionId: "" },
    ]) assert.equal((await post(request("availability", { ...availability, ...extra }))).status, 400);
    assert.equal(calls.length, 0);
  }));

test("isolated preview availability never writes into production, even with a production token", async () =>
  mocked({}, async (calls) => {
    const post = await load("availability", "preview");
    let result = await post(request("availability", availability));
    assert.equal(result.status, 200);
    assert.ok(calls.every((call) => ![IDS.buP, IDS.buA, IDS.bcP, IDS.bcA].some((id) => call.path.includes(id))));
    assert.ok(calls.every((call) => call.auth === "Bearer preview-test-token"));
    calls.length = 0;
    result = await post(request("availability", { ...availability, universityChoice: "bc" }));
    assert.equal(result.status, 503);
    assert.equal(calls.length, 0);
  }));

test("availability duplicate request repairs partial failure without creating another record", async () =>
  mocked({ pipelineRows: [row("bc-person")], availabilityQueries: (body) =>
    body.filter?.property === "Submission ID"
      ? [profile("same-submission")]
      : [profile("old-submission"), profile("same-submission")] }, async (calls) => {
    const post = await load("availability");
    const response = await post(request("availability", { ...availability, universityChoice: "bc" }));
    assert.equal(response.status, 200);
    assert.equal(creates(calls).length, 0);
    assert.ok(calls.some((c) => c.path === "/v1/pages/old-submission" && c.body.properties.Superseded.checkbox === true));
    assert.ok(calls.some((c) => c.path === "/v1/pages/bc-person" && c.body.properties["Needs Full Availability"].checkbox === false));
  }));

test("a recycled availability submission ID cannot attach to a different email", async () =>
  mocked({ pipelineRows: [row("bc-person")], availabilityQueries: (body) =>
    body.filter?.property === "Submission ID"
      ? [profile("other-profile", "bc-person", "someone-else@example.edu")]
      : [] }, async (calls) => {
    const post = await load("availability");
    const response = await post(request("availability", { ...availability, universityChoice: "bc" }));
    assert.equal(response.status, 409);
    assert.equal(creates(calls).length, 0);
  }));

test("ambiguous same-name availability is not assigned to someone else's email", async () =>
  mocked({ pipelineRows: [row("bc-person", "someone-else@example.edu")] }, async (calls) => {
    const post = await load("availability");
    const response = await post(request("availability", { ...availability, universityChoice: "bc" }));
    assert.equal(response.status, 200);
    assert.equal(creates(calls)[0].body.properties["Volunteer Record"], undefined);
    assert.equal(creates(calls)[0].body.properties["Identity Status"].select.name, "Name only");
  }));
