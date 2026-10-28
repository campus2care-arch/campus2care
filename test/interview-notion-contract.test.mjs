import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../lib/interview-notion-contract.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const contract = await import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"));

const applicant = () => ({
  email:"synthetic-student@example.invalid",stage:"Needs Interview",
  nextStep:"Schedule interview",interviewStatus:"Not Scheduled",
  workflowStatus:"Application Received",
});

test("BU and BC always point at different verified canonical Notion pipelines", () => {
  assert.notEqual(contract.campusPipelineId("BU"), contract.campusPipelineId("BC"));
  contract.assertCampusPipelineParent("BU", "03192649-7414-42fe-86ac-dddcc7320798");
  contract.assertCampusPipelineParent("BC", "bc8eaec9-a5d4-49cd-8742-6e8613299a93");
  assert.throws(() => contract.assertCampusPipelineParent("BU", contract.campusPipelineId("BC")), /campus_mismatch/);
  assert.throws(() => contract.campusPipelineId("other"), /invalid_campus/);
});

test("first invitation requires reviewed applicant state and valid email", () => {
  for (const campus of ["BU","BC"]) {
    assert.deepEqual(contract.evaluateInitialInterviewEligibility(campus,applicant()),
      {eligible:true,reason:"eligible_for_reviewed_invitation"});
    assert.equal(contract.evaluateInitialInterviewEligibility(campus,{...applicant(),email:""}).eligible,false);
    assert.equal(contract.evaluateInitialInterviewEligibility(campus,{...applicant(),nextStep:"No action"}).eligible,false);
    assert.equal(contract.evaluateInitialInterviewEligibility(campus,{...applicant(),stage:"Needs Workshop"}).eligible,false);
    assert.equal(contract.evaluateInitialInterviewEligibility(campus,{...applicant(),interviewStatus:"Scheduled"}).eligible,false);
    assert.equal(contract.evaluateInitialInterviewEligibility(campus,{...applicant(),interviewStatus:"Completed"}).eligible,false);
    assert.equal(contract.evaluateInitialInterviewEligibility(campus,{...applicant(),workflowStatus:"Paused"}).eligible,false);
    assert.equal(contract.evaluateInitialInterviewEligibility(campus,{...applicant(),workflowStatus:"Withdrawn / Not Proceeding"}).eligible,false);
  }
});

test("BU supports Interview Scheduled workflow but BC currently does not", () => {
  const state={...applicant(),workflowStatus:"Interview Needed"};
  assert.equal(contract.evaluateInitialInterviewEligibility("BU",state).eligible,true);
  assert.equal(contract.evaluateInitialInterviewEligibility("BC",state).eligible,false);
  const date="2026-11-02T14:00:00.000Z";
  const bu=contract.scheduledInterviewNotionPatch("BU",date);
  const bc=contract.scheduledInterviewNotionPatch("BC",date);
  assert.equal(bu["Interview Status"].select.name,"Scheduled");
  assert.equal(bc["Interview Status"].select.name,"Scheduled");
  assert.deepEqual(bu["Interview Date"],bc["Interview Date"]);
  assert.equal(bu["Workflow Status"].select.name,"Interview Scheduled");
  assert.equal("Workflow Status" in bc,false);
  assert.equal("Executive Associate Owner" in bu,false);
  assert.equal("Executive Associate Owner" in bc,false);
  assert.equal("Interviewed By" in bc,false);
});

test("invalid interview instants fail closed", () => {
  assert.throws(() => contract.scheduledInterviewNotionPatch("BU","not-a-date"),/invalid_interview_start/);
  assert.throws(() => contract.scheduledInterviewNotionPatch("BC","2026-11-02T14:00:00Z"),/invalid_interview_start/);
});
