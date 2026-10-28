import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const compile = (source) => ts.transpileModule(source, {
  compilerOptions: {module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022},
}).outputText;
const asUrl = (src) => "data:text/javascript;base64," + Buffer.from(src).toString("base64");
const contract = asUrl(compile(await readFile(
  new URL("../lib/interview-notion-contract.ts",import.meta.url),"utf8")));
const source = compile(await readFile(
  new URL("../lib/interview-notion-preview.ts",import.meta.url),"utf8"))
  .replace('from "./interview-notion-contract"', 'from "' + contract + '"');
const adapter = await import(asUrl(source));

const bu = "11111111-1111-4111-8111-111111111111";
const bc = "22222222-2222-4222-8222-222222222222";
const pageId = "33333333-3333-4333-8333-333333333333";
const setup=()=>{
  process.env.VERCEL_ENV="preview";
  process.env.INTERVIEW_NOTION_READS_ENABLED="true";
  process.env.INTERVIEW_NOTION_BU_STAGING_DB_ID=bu;
  process.env.INTERVIEW_NOTION_BC_STAGING_DB_ID=bc;
  process.env.INTERVIEW_NOTION_STAGING_TOKEN="not-real-synthetic-credential-string";
};
const select=(name)=>({type:"select",select:{name}});
const page=(parent=bu, overrides={})=>({
  id:pageId,archived:false,parent:{type:"database_id",database_id:parent},
  properties:{
    Email:{type:"email",email:"staging-person@example.invalid"},
    Stage:select("Needs Interview"),
    "Next Step":select("Schedule interview"),
    "Interview Status":select("Not Scheduled"),
    "Workflow Status":select("Application Received"),
    ...overrides,
  },
});
const fakeFetch=(value)=>async (url,opts)=>{
  assert.equal(opts.method,"GET");
  assert.equal(url,"https://api.notion.com/v1/pages/"+pageId.replaceAll("-",""));
  return new Response(JSON.stringify(value),{status:200});
};

test("no Notion read in production, regardless of credentials",async()=>{
  setup();process.env.VERCEL_ENV="production";
  await assert.rejects(adapter.checkSyntheticNotionInvitationEligibility("BU",pageId, fakeFetch(page())),
    /preview_notion_reads_disabled/);
});

test("preview refuses live BU or BC database targets, and requires distinct clones",()=>{
  setup();
  process.env.INTERVIEW_NOTION_BU_STAGING_DB_ID="03192649741442fe86acdddcc7320798";
  assert.throws(adapter.previewNotionConfiguration,/production_notion_database_forbidden/);
  setup();process.env.INTERVIEW_NOTION_BC_STAGING_DB_ID=bu;
  assert.throws(adapter.previewNotionConfiguration,/production_notion_database_forbidden/);
});

test("synthetic BU and BC profiles are resolved independently",async()=>{
  setup();
  assert.deepEqual(await adapter.checkSyntheticNotionInvitationEligibility("BU",pageId,fakeFetch(page(bu))),
    {eligible:true,reason:"eligible_for_reviewed_invitation"});
  assert.deepEqual(await adapter.checkSyntheticNotionInvitationEligibility("BC",pageId,fakeFetch(page(bc))),
    {eligible:true,reason:"eligible_for_reviewed_invitation"});
  await assert.rejects(adapter.checkSyntheticNotionInvitationEligibility("BU",pageId,fakeFetch(page(bc))),
    /preview_notion_campus_mismatch/);
});

test("read-only staging rejects real applicant identifiers and inactive profiles",async()=>{
  setup();
  await assert.rejects(adapter.checkSyntheticNotionInvitationEligibility("BU",pageId,
    fakeFetch(page(bu,{Email:{type:"email",email:"realstudent@bu.edu"}}))),
    /real_applicant_forbidden_in_preview/);
  const stopped=await adapter.checkSyntheticNotionInvitationEligibility("BU",pageId,
    fakeFetch(page(bu,{"Workflow Status":select("Paused")})));
  assert.equal(stopped.eligible,false);
  const complete=await adapter.checkSyntheticNotionInvitationEligibility("BU",pageId,
    fakeFetch(page(bu,{"Interview Status":select("Completed")})));
  assert.equal(complete.eligible,false);
});

test("Notion page identity and source-ownership errors fail closed",async()=>{
  setup();
  await assert.rejects(adapter.checkSyntheticNotionInvitationEligibility("BU",pageId,
    fakeFetch({...page(),id:bc})),/preview_notion_identity_mismatch/);
  await assert.rejects(adapter.checkSyntheticNotionInvitationEligibility("BU",pageId,
    fakeFetch({...page(),archived:true})),/preview_notion_identity_mismatch/);
  await assert.rejects(adapter.checkSyntheticNotionInvitationEligibility("BU",pageId,
    async()=>new Response("denied",{status:403})),/preview_notion_lookup_failed/);
});

test("a previously invited email cannot book after the Notion source email changes",async()=>{
  setup();
  await assert.rejects(adapter.checkSyntheticNotionInvitationEligibility("BU",pageId,
    fakeFetch(page(bu, {Email:{type:"email",email:"new-applicant@example.invalid"}})),
    "staging-person@example.invalid"),/pipeline_applicant_email_changed/);
  assert.deepEqual(await adapter.checkSyntheticNotionInvitationEligibility("BU",pageId,
    fakeFetch(page(bu)),"STAGING-PERSON@example.invalid"),
    {eligible:true,reason:"eligible_for_reviewed_invitation"});
});
