import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const compile=(src)=>ts.transpileModule(src,{
  compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022},
}).outputText;
const data=(src)=>"data:text/javascript;base64,"+Buffer.from(src).toString("base64");
const db=data(`
  let jobs=[];
  let completed=[];
  export function load(values){jobs=[...values];completed=[]}
  export function finished(){return completed}
  const query=async(strings,...values)=>{
    const text=strings.join("?");
    if(text.includes("WITH candidate AS")) return jobs.shift() ? [{id:"synthetic-job",operation_key:"synthetic-test",provider:"gmail",action:"send",object_id:"synthetic-target",attempts:1}] : [];
    if(text.includes("UPDATE interview.integration_outbox") && text.includes("RETURNING id")){
      completed.push(values);return [{id:"synthetic-job"}];
    }
    return [];
  };
  export function interviewDatabase(){return query}
`);
const source=compile(await readFile(new URL("../lib/interview-outbox.ts",import.meta.url),"utf8"))
  .replace('from "./interview-db"','from "'+db+'"');
const lib=await import(data(source)),mock=await import(db);

test("worker remains off in production even if a flag was misconfigured",async()=>{
  process.env.VERCEL_ENV="production";process.env.INTERVIEW_OUTBOX_WORKER_ENABLED="true";
  assert.equal(lib.isInterviewWorkerEnabled(),false);
  await assert.rejects(lib.processInterviewOutboxBatch(async()=>({state:"done",externalId:null})),
    /interview_outbox_disabled/);
});

test("worker requires a preview-only explicit opt-in and a provider handler",async()=>{
  process.env.VERCEL_ENV="preview";process.env.INTERVIEW_OUTBOX_WORKER_ENABLED="false";
  assert.equal(lib.isInterviewWorkerEnabled(),false);
  process.env.INTERVIEW_OUTBOX_WORKER_ENABLED="true";
  await assert.rejects(lib.processInterviewOutboxBatch(null),/invalid_interview_outbox_worker/);
  await assert.rejects(lib.processInterviewOutboxBatch(async()=>({state:"done",externalId:null}),100),/invalid_interview_outbox_worker/);
});

test("retry backoff increases and is bounded",()=>{
  assert.equal(lib.outboxBackoffSeconds(1),30);
  assert.equal(lib.outboxBackoffSeconds(2),60);
  assert.equal(lib.outboxBackoffSeconds(3),120);
  assert.ok(lib.outboxBackoffSeconds(20)<=86400);
  assert.throws(()=>lib.outboxBackoffSeconds(0),/invalid_outbox_attempt/);
});

test("completed handler uses one claimed operation without repeated sends",async()=>{
  process.env.VERCEL_ENV="preview";process.env.INTERVIEW_OUTBOX_WORKER_ENABLED="true";
  mock.load([1]);
  let called=0;
  const result=await lib.processInterviewOutboxBatch(async(job)=>{
    called++;assert.equal(job.operation_key,"synthetic-test");
    return {state:"done",externalId:"synthetic-external"};
  },5);
  assert.deepEqual(result,{claimed:1,completed:1,needsReconciliation:0});
  assert.equal(called,1);
  assert.equal(mock.finished().length,1);
});

test("unknown provider exceptions are isolated for reconciliation, not blind resend",async()=>{
  process.env.VERCEL_ENV="preview";process.env.INTERVIEW_OUTBOX_WORKER_ENABLED="true";
  mock.load([1]);
  const result=await lib.processInterviewOutboxBatch(async()=>{throw new Error("timeout-after-send")},1);
  assert.deepEqual(result,{claimed:1,completed:0,needsReconciliation:1});
  assert.equal(mock.finished().length,1);
});
