import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

const config = await readFile(new URL("../next.config.ts", import.meta.url), "utf8");
const page = await readFile(new URL("../app/application/page.tsx", import.meta.url), "utf8");

test("BU and BC direct application links redirect to the working shared form", () => {
  for (const campus of ["bu", "bc"]) {
    for (const source of ["/apply/" + campus, "/application/" + campus, "/" + campus + "/application", "/" + campus + "/apply"]) {
      assert.ok(config.includes('source: "' + source + '"'), source + " must redirect");
    }
    assert.ok(config.includes('destination: "/application?campus=' + campus + '"'));
  }
  assert.ok(config.includes('source: "/apply"'));
});

test("application honors campus preselection without overriding applicant changes", () => {
  assert.ok(page.includes('new URLSearchParams(window.location.search).get("campus")'));
  assert.ok(page.includes('current.universityChoice ? current :'));
  assert.ok(page.includes('campus === "bu" ? "Boston University" : "Boston College"'));
});
