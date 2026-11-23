import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

const routeSource = await readFile(new URL("../app/api/jarvis/outreach-workflow/route.ts", import.meta.url), "utf8");
const bannerSource = await readFile(new URL("../app/api/jarvis/banner/route.ts", import.meta.url), "utf8");
const { GET } = await import(dataUrl(compile(routeSource)));

const EXPECTED_SHA256 = "9f0291d6c03e3cf3e9110857b411136ff9ff7af69c8297a9a0b45d3a79195116";

function headerBlock(source) {
  const match = source.match(/const headers = \{[\s\S]*?\n\};/);
  assert.ok(match, "headers block");
  return match[0];
}

test("the outreach workflow route serves the exact animation with banner headers", async () => {
  assert.equal(headerBlock(routeSource), headerBlock(bannerSource));
  assert.match(routeSource, /export const dynamic = "force-dynamic";/);
  assert.match(bannerSource, /export const dynamic = "force-dynamic";/);

  const response = await GET();
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(createHash("sha256").update(html).digest("hex"), EXPECTED_SHA256);
  assert.equal(Buffer.byteLength(html), 4490);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-frame-options"), null);
  assert.equal(
    response.headers.get("content-security-policy"),
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self' https://www.campus2care.org; frame-ancestors https://app.notion.com https://www.notion.so https://*.notion.so https://*.notion.site",
  );
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});
