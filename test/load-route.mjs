import { readFile } from "node:fs/promises";
import ts from "typescript";

const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const url = (source) => "data:text/javascript;base64," + Buffer.from(source).toString("base64");
let sequence = 0;
const summary = url(compile(await readFile(new URL("../lib/availability-summary.ts", import.meta.url), "utf8")));
const recovery = await readFile(new URL("../lib/submission-recovery.ts", import.meta.url), "utf8");
// Atomic fake object storage. Routes still execute the real receipt, locking, and retry code.
const fakeBlob = `
  const blobs = new Map(); let revision = 0;
  export async function put(path, body, options) {
    const old = blobs.get(path);
    if (old && options.allowOverwrite === false) throw new Error('exists');
    if (options.ifMatch && old?.etag !== options.ifMatch) throw new Error('precondition');
    const saved = {body, etag: String(++revision)}; blobs.set(path, saved); return saved;
  }
  export async function get(path) {
    const saved = blobs.get(path); if (!saved) return null;
    return {statusCode: 200, stream: new Response(saved.body).body, blob: {etag: saved.etag}};
  }
  export async function del(path, options) {
    if (options?.ifMatch && blobs.get(path)?.etag !== options.ifMatch) throw new Error('precondition');
    blobs.delete(path);
  }
  export async function list() { return {blobs: [...blobs.keys()].filter(pathname => pathname.startsWith('submissions/v1/')).map(pathname => ({pathname})), hasMore:false}; }
`;

export async function loadRecovery() {
  const storage = url(fakeBlob + `\n// instance ${++sequence}`);
  const compiledSource = compile(recovery).replace('from "@vercel/blob"', `from ${JSON.stringify(storage)}`);
  return import(url(compiledSource));
}

export async function loadRoute(source) {
  process.env.BLOB_READ_WRITE_TOKEN = "test-private-store";
  const storage = url(fakeBlob + `\n// route instance ${++sequence}`);
  const helper = url(compile(recovery).replace('from "@vercel/blob"', `from ${JSON.stringify(storage)}`));
  const compiledSource = compile(source).replace('from "../../../lib/availability-summary"', `from ${JSON.stringify(summary)}`).replace('from "../../../lib/submission-recovery"', `from ${JSON.stringify(helper)}`);
  return import(url(compiledSource) + "#" + sequence);
}
