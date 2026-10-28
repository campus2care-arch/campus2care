import test from "node:test";
import assert from "node:assert/strict";
import {loadInterviewModule} from "./interview-test-loader.mjs";

const BU="fdf07f2371de46c9904fa666f5b1cc79", BC="f0f0eabe53bb46e99699577ce6b68ee0";
const pageIds=["407d6c55-a9de-8194-b14d-e7f70cc5ed22","407d6c55-a9de-815c-9363-d831bece88f2"];
const select=(name)=>({type:"select",select:{name}});
function page(id,parent,email,workflow){
  return {object:"page",id,parent:{type:"database_id",database_id:parent},archived:false,
    properties:{Email:{type:"email",email},Stage:select("Needs Interview"),
      "Next Step":select("Schedule interview"),"Interview Status":select("Not Scheduled"),
      "Workflow Status":select(workflow)}};
}
function fixture(buPages,bcPages){
  Object.assign(process.env,{VERCEL_ENV:"preview",INTERVIEW_SYNTHETIC_PIPELINE_SCAN_ENABLED:"true",
    INTERVIEW_SYNTHETIC_DISPATCH_ENABLED:"true",INTERVIEW_NOTION_READS_ENABLED:"true"});
  const queries=[],inserts=[],seen=new Set();
  const tx=async (strings,...values)=>{
    const sql=strings.join("?");queries.push({sql,values});
    if(sql.includes("SELECT i.id FROM interview.invitation i")){
      const hmac=values[2];return seen.has(hmac)?[{id:"existing"}]:[];
    }
    if(sql.includes("INSERT INTO interview.invitation"))seen.add(values[3]);
    if(sql.includes("INSERT INTO interview."))inserts.push(sql);
    return [];
  };tx.begin=fn=>fn(tx);tx.json=x=>x;
  const calls=[];
  const transport=async (url,options)=>{
    assert.equal(options.method,"POST");assert.equal(new URL(url).hostname,"api.notion.com");
    const id=url.split("/")[5];calls.push(id);
    return Response.json({results:id===BU?buPages:bcPages,has_more:false,next_cursor:null});
  };
  const module=loadInterviewModule("interview-pipeline-enrollment",{
    "./interview-db":{interviewDatabase:()=>tx},
    "./interview-notion-preview":{previewNotionConfiguration:()=>({buId:BU,bcId:BC,token:"synthetic-token"}),
      PreviewNotionReadError:class extends Error {}},
    "./interview-invitations":{applicantRecipientHmac:email=>email.padEnd(64,"a")},
  });
  return {module,queries,inserts,calls,transport};
}

test("synthetic BU and BC pipeline discovery creates separate recipient-bound invitations once",async()=>{
  const f=fixture([page(pageIds[0],BU,"bu@example.invalid","Interview Needed")],
    [page(pageIds[1],BC,"bc@example.invalid","Application Received")]);
  assert.deepEqual(await f.module.enrollSyntheticPipelineApplicants(f.transport),{enrolled:2,skipped:0,reviewed:2});
  assert.equal(f.inserts.filter(sql=>sql.includes("INSERT INTO interview.invitation")).length,2);
  assert.equal(f.inserts.filter(sql=>sql.includes("INSERT INTO interview.notion_staging_binding")).length,2);
  assert.deepEqual(f.calls,[BU,BC]);
  assert.deepEqual(await f.module.enrollSyntheticPipelineApplicants(f.transport),{enrolled:0,skipped:2,reviewed:2});
});

test("stage, real email, and already completed interview block automatic enrollment",async()=>{
  const complete=page(pageIds[0],BU,"completed@example.invalid","Interview Needed");
  complete.properties["Interview Status"]=select("Completed");
  const f=fixture([complete,page(pageIds[0],BU,"someone@gmail.com","Interview Needed")],[]);
  assert.deepEqual(await f.module.enrollSyntheticPipelineApplicants(f.transport),{enrolled:0,skipped:2,reviewed:2});
  assert.equal(f.inserts.length,0);
});

test("wrong campus parent fails closed before invitation creation",async()=>{
  const f=fixture([page(pageIds[0],BC,"bu@example.invalid","Interview Needed")],[]);
  await assert.rejects(f.module.enrollSyntheticPipelineApplicants(f.transport),/pipeline_scan_wrong_parent/);
  assert.equal(f.inserts.length,0);
});

test("pipeline scanning is completely disabled in production",async()=>{
  const f=fixture([],[]);
  process.env.VERCEL_ENV="production";
  await assert.rejects(f.module.enrollSyntheticPipelineApplicants(f.transport),/pipeline_scan_disabled/);
  assert.equal(f.calls.length,0);
});
