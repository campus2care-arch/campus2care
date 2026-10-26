import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { loadRoute } from "./load-route.mjs";

const source = await readFile(new URL("../app/api/application/route.ts", import.meta.url), "utf8");
async function loadPost({
  env = "preview",
  token = "test-token",
  pipelineDb = "qa-pipeline-database",
  availabilityDb = "qa-availability-database",
} = {}) {
  Object.assign(process.env, {
    VERCEL_ENV: env,
    NOTION_TOKEN: env === "production" ? token : "production-test-token",
    NOTION_PREVIEW_TOKEN: env === "production" ? "" : token,
    NOTION_PIPELINE_DATABASE_ID: pipelineDb,
    NOTION_AVAILABILITY_DATABASE_ID: availabilityDb,
  });
  return (await loadRoute(source)).POST;
}

const payload = {
  submissionId: "submission-001", fullName: "Jordan Applicant", email: "jordan@example.edu",
  phone: "+1 617 555 0101", universityChoice: "bu", school: "Boston University", graduationYear: 2029,
  major: "Biology", clinicalCertification: "No", priorClinicalExperience: "No",
  comfortableWithPatients: "Yes", preferredStartDate: "2026-11-01", weeklyCommitmentHours: 8,
  motivation: "I want to support patients.", referralSource: "Campus fair", totalHours: 8,
  longestWeekdayBlockHours: 4, meetsWeekdayBlock: true,
  availabilityByDay: {
    Monday: "9 AM–1 PM", Tuesday: "10 AM–2 PM", Wednesday: "1 PM–5 PM",
    Thursday: "9 AM–1 PM", Friday: "Not available", Saturday: "Not available", Sunday: "Not available",
  },
};

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
const request = (body = payload) => new Request("https://campus2care.test/api/application", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const parseCall = (url, init = {}) => ({
  url: new URL(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined,
});

function pipelineRow({
  id = "pipeline-existing", name = payload.fullName, email = payload.email,
  submissionId = payload.submissionId, owner = "Edla", stage = "Needs Interview",
  workflow = "Application Received", applicationSource = "Website Application",
  createdTime = "2026-10-16T00:00:00Z",
} = {}) {
  return { id, created_time: createdTime, properties: {
    Volunteer: { title: [{ plain_text: name }] }, Email: { email },
    "Alternate Email": { email: null },
    "Application Submission ID": { rich_text: [{ plain_text: submissionId }] },
    "Executive Associate Owner": { select: { name: owner } },
    "Application Source": { select: { name: applicationSource } },
    Stage: stage ? { select: { name: stage } } : null,
    "Workflow Status": { select: { name: workflow } },
  } };
}

function availabilityRow({
  id = "availability-current", email = payload.email, pipelineId = "pipeline-existing",
  submissionId = payload.submissionId, superseded = false,
} = {}) {
  return { id, properties: {
    Email: { email }, "Volunteer Record": { relation: [{ id: pipelineId }] },
    "Submission ID": { rich_text: [{ plain_text: submissionId }] },
    Superseded: { checkbox: superseded },
  } };
}

async function withFetch(mock, action) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try { return await action(); } finally { globalThis.fetch = originalFetch; }
}

test("Preview refuses canonical or shared databases and rejects a missing phone", async () => {
  await withFetch(async () => { throw new Error("Preview gate must stop before Notion fetch"); }, async () => {
    const sameDb = await loadPost({ pipelineDb: "same", availabilityDb: "same" });
    assert.equal((await sameDb(request())).status, 503);
    const canonicalDb = await loadPost({
      pipelineDb: "03192649741442fe86acdddcc7320798",
      availabilityDb: "qa-availability-database",
    });
    assert.equal((await canonicalDb(request())).status, 503);
    const post = await loadPost();
    assert.equal((await post(request({ ...payload, phone: " " }))).status, 400);
  });
});

test("Preview requires its isolated token even when a production token exists", async () => {
  await withFetch(async () => { throw new Error("Preview token gate must stop before Notion fetch"); }, async () => {
    const post = await loadPost({ token: "" });
    assert.equal((await post(request())).status, 503);
  });
});

test("writes a new applicant and linked seven-day profile using the next owner in rotation", async () => {
  const loads = [["Edla", 15], ["Cori", 14], ["Barthina", 13], ["Juliette", 12], ["Allison", 11], ["Nitara", 10], ["Anjolie", 2], ["Emily", 1]];
  const active = loads.flatMap(([owner, count], group) => Array.from({ length: count }, (_, i) =>
    pipelineRow({ id: `active-${group}-${i}`, name: `Active ${group}-${i}`, email: `active-${group}-${i}@example.edu`, submissionId: `active-${group}-${i}`, owner }),
  ));
  const ignored = Array.from({ length: 85 }, (_, i) => pipelineRow({
    id: `ignored-${i}`, name: `Ignored ${i}`, email: `ignored-${i}@example.edu`,
    submissionId: `ignored-${i}`, owner: "Edla", stage: null,
    workflow: i % 2 ? "Paused" : "Withdrawn / Not Proceeding",
  }));
  const rows = [...active, ...ignored, pipelineRow({
    id: "latest-web-application", name: "Prior website applicant",
    email: "prior@example.edu", submissionId: "prior-website-submission",
    owner: "Edla", createdTime: "2026-10-17T00:00:00Z",
  })];
  const calls = [];
  let pipelineQueries = 0;

  await withFetch(async (url, init = {}) => {
    const call = parseCall(url, init); calls.push(call);
    if (call.url.pathname === "/v1/databases/qa-pipeline-database/query") {
      pipelineQueries += 1;
      const start = call.body.start_cursor ? 100 : 0;
      return jsonResponse({ results: rows.slice(start, start + 100), has_more: start === 0, next_cursor: start === 0 ? "page-two" : undefined });
    }
    if (call.url.pathname === "/v1/databases/qa-availability-database/query") return jsonResponse({ results: [] });
    if (call.url.pathname === "/v1/pages" && call.method === "POST") {
      return jsonResponse({ id: call.body.parent.database_id === "qa-pipeline-database" ? "pipeline-created" : "availability-created" });
    }
    if (call.url.pathname === "/v1/pages/pipeline-created" && call.method === "PATCH") return jsonResponse({ id: "pipeline-created" });
    throw new Error(`Unexpected mock request: ${call.method} ${call.url.pathname}`);
  }, async () => {
    const post = await loadPost();
    const result = await post(request());
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), {
      ok: true, pipelineAction: "created", pipelineId: "pipeline-created", availabilityId: "availability-created",
    });
  });

  assert.equal(pipelineQueries, 2);
  assert.equal(calls[0].headers.Authorization, "Bearer test-token");
  const pipelineCreate = calls.find((c) => c.url.pathname === "/v1/pages" && c.method === "POST" && c.body.parent.database_id === "qa-pipeline-database");
  assert.equal(pipelineCreate.body.properties["Executive Associate Owner"].select.name, "Emily");
  assert.equal(pipelineCreate.body.properties["Application Source"].select.name, "Website Application");
  assert.equal(pipelineCreate.body.properties.Phone.phone_number, payload.phone);
  assert.equal(pipelineCreate.body.properties["Needs Full Availability"].checkbox, true);

  const profileCreate = calls.find((c) => c.url.pathname === "/v1/pages" && c.method === "POST" && c.body.parent.database_id === "qa-availability-database");
  assert.deepEqual(profileCreate.body.properties["Volunteer Record"].relation, [{ id: "pipeline-created" }]);
  assert.equal(profileCreate.body.properties["Submission ID"].rich_text[0].text.content, payload.submissionId);
  for (const [day, value] of Object.entries(payload.availabilityByDay)) {
    assert.equal(profileCreate.body.properties[day].rich_text[0].text.content, value);
  }
  const completion = calls.find((c) => c.url.pathname === "/v1/pages/pipeline-created" && c.method === "PATCH");
  assert.equal(completion.body.properties["Needs Full Availability"].checkbox, false);
});

test("cycles new applications through the ordered eight-person roster", async () => {
  const expected = ["Barthina", "Cori", "Edla", "Emily", "Juliette", "Nitara", "Allison", "Anjolie"];
  const rows = [pipelineRow({
    id: "rotation-seed", name: "Previous website applicant",
    email: "previous@example.edu", submissionId: "previous-submission",
    owner: "Anjolie", createdTime: "2026-10-15T00:00:00Z",
  })];
  let nextId = 0;
  const assigned = [];
  const post = await loadPost();

  for (let i = 0; i < expected.length; i += 1) {
    const applicant = {
      ...payload,
      submissionId: `rotation-${i}`,
      fullName: `Rotation Applicant ${String.fromCharCode(65 + i)}`,
      email: `rotation-${i}@example.edu`,
    };
    await withFetch(async (url, init = {}) => {
      const call = parseCall(url, init);
      if (call.url.pathname === "/v1/databases/qa-pipeline-database/query") {
        return jsonResponse({ results: rows, has_more: false });
      }
      if (call.url.pathname === "/v1/databases/qa-availability-database/query") {
        return jsonResponse({ results: [] });
      }
      if (call.url.pathname === "/v1/pages" && call.method === "POST") {
        const id = `rotation-created-${nextId++}`;
        if (call.body.parent.database_id === "qa-pipeline-database") {
          const owner = call.body.properties["Executive Associate Owner"].select.name;
          assigned.push(owner);
          rows.push(pipelineRow({
            id,
            name: call.body.properties.Volunteer.title[0].text.content,
            email: call.body.properties.Email.email,
            submissionId: call.body.properties["Application Submission ID"].rich_text[0].text.content,
            owner,
            applicationSource: call.body.properties["Application Source"].select.name,
            createdTime: `2026-10-17T00:00:0${i}Z`,
          }));
        }
        return jsonResponse({ id });
      }
      if (call.url.pathname.startsWith("/v1/pages/") && call.method === "PATCH") {
        return jsonResponse({ id: call.url.pathname.split("/").at(-1) });
      }
      throw new Error(`Unexpected mock request: ${call.method} ${call.url.pathname}`);
    }, async () => {
      const response = await post(request(applicant));
      const responseBody = await response.json();
      assert.equal(response.status, 200, `rotation item ${i} failed: ${JSON.stringify(responseBody)}`);
    });
  }

  assert.deepEqual(assigned, expected);
});

test("retry updates existing records without creating duplicates and supersedes old availability", async () => {
  const calls = [];
  await withFetch(async (url, init = {}) => {
    const call = parseCall(url, init); calls.push(call);
    if (call.url.pathname === "/v1/databases/qa-pipeline-database/query") return jsonResponse({ results: [pipelineRow()], has_more: false });
    if (call.url.pathname === "/v1/databases/qa-availability-database/query") {
      return jsonResponse(call.body.filter.property === "Submission ID"
        ? { results: [availabilityRow()] }
        : { results: [availabilityRow(), availabilityRow({ id: "availability-old", submissionId: "old-submission" })] });
    }
    if (call.url.pathname.startsWith("/v1/pages/") && call.method === "PATCH") return jsonResponse({ id: call.url.pathname.split("/").at(-1) });
    throw new Error(`Unexpected mock request: ${call.method} ${call.url.pathname}`);
  }, async () => {
    const post = await loadPost();
    const result = await post(request());
    assert.equal(result.status, 200);
    assert.equal((await result.json()).pipelineAction, "updated");
  });
  assert.equal(calls.filter((c) => c.url.pathname === "/v1/pages" && c.method === "POST").length, 0);
  assert.equal(calls.find((c) => c.url.pathname === "/v1/pages/availability-old").body.properties.Superseded.checkbox, true);
  const pipelinePatches = calls.filter((c) => c.url.pathname === "/v1/pages/pipeline-existing");
  assert.equal(pipelinePatches.at(-1).body.properties["Needs Full Availability"].checkbox, false);
});

test("submission identity conflicts and duplicate profiles return 409 before writes", async (t) => {
  await t.test("submission ID belongs to a different email", async () => {
    const calls = [];
    await withFetch(async (url, init = {}) => {
      const call = parseCall(url, init); calls.push(call);
      if (call.url.pathname === "/v1/databases/qa-pipeline-database/query") return jsonResponse({ results: [pipelineRow({ email: "other@example.edu" })], has_more: false });
      throw new Error(`Unexpected mock request: ${call.method} ${call.url.pathname}`);
    }, async () => {
      const result = await (await loadPost())(request());
      assert.equal(result.status, 409);
      assert.deepEqual(await result.json(), { ok: false, error: "identity_conflict", recoverable: false });
    });
    assert.equal(calls.some((c) => c.url.pathname.startsWith("/v1/pages/")), false);
  });

  await t.test("multiple profiles exist for the same submission", async () => {
    const calls = [];
    await withFetch(async (url, init = {}) => {
      const call = parseCall(url, init); calls.push(call);
      if (call.url.pathname === "/v1/databases/qa-pipeline-database/query") return jsonResponse({ results: [pipelineRow()], has_more: false });
      if (call.url.pathname === "/v1/databases/qa-availability-database/query") return jsonResponse({ results: [availabilityRow(), availabilityRow({ id: "availability-duplicate" })] });
      throw new Error(`Unexpected mock request: ${call.method} ${call.url.pathname}`);
    }, async () => {
      const result = await (await loadPost())(request());
      assert.equal(result.status, 409);
      assert.deepEqual(await result.json(), { ok: false, error: "identity_conflict", recoverable: false });
    });
    assert.equal(calls.some((c) => c.url.pathname.startsWith("/v1/pages/")), false);
  });
});
