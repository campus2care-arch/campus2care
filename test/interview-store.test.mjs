import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const compile = (text) => ts.transpileModule(text, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const asUrl = (value) => "data:text/javascript;base64," + Buffer.from(value).toString("base64");
const availability = asUrl(compile(await readFile(new URL("../lib/interview-availability.ts", import.meta.url), "utf8")));
const fakeBlob = asUrl(String.raw