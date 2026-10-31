import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../lib/interview-public-gate.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const gate = await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
test('preview requires explicit booking flag',()=>{
 assert.equal(gate.interviewPublicMode({VERCEL_ENV:'preview',INTERVIEW_BOOKING_ENABLED:'true'}),'synthetic-preview');
 assert.equal(gate.interviewPublicMode({VERCEL_ENV:'preview',INTERVIEW_BOOKING_ENABLED:'false'}),'not-open');
});
test('live site stays closed until independent production booking is built',()=>{
 assert.equal(gate.interviewPublicMode({VERCEL_ENV:'production',INTERVIEW_BOOKING_ENABLED:'true'}),'not-open');
 assert.equal(gate.interviewPublicMode({VERCEL_ENV:'production',INTERVIEW_BOOKING_ENABLED:'false'}),'not-open');
});
