import test from "node:test";
import assert from "node:assert/strict";
import { loadInterviewModule } from "./interview-test-loader.mjs";
const { productionNotionStatus } = loadInterviewModule("interview-production-notion-status");
const { campusPipelineId } = loadInterviewModule("interview-notion-contract");

function tokenForTest(t, value) {
  const original = process.env.INTERVIEW_NOTION_LIVE_TOKEN;
  process.env.INTERVIEW_NOTION_LIVE_TOKEN = value;
  t.after(() => {
    if (original === undefined) delete process.env.INTERVIEW_NOTION_LIVE_TOKEN;
    else process.env.INTERVIEW_NOTION_LIVE_TOKEN = original;
  });
}

function database(campus) {
  const types = { Email:"email", Stage:"select", "Next Step":"select", "Workflow Status":"select",
    "Interview Status":"select", "Interview Date":"date", "Interviewed By":"rich_text",
    "Scheduling Reservation ID":"rich_text", "Google Meet URL":"url" };
  const properties = Object.fromEntries(Object.entries(types).map(([name,type])=>[name,{type}]));
  const options = {Stage:["Needs Interview"],"Next Step":["Schedule interview"],
    "Interview Status":["Not Scheduled","Scheduled"],
    "Workflow Status":campus==="BU"?["Application Received","Interview Needed","Interview Scheduled"]:["Application Received"]};
  for(const [name,values] of Object.entries(options)) properties[name].select={options:values.map(name=>({name}))};
  return {object:"database",id:campusPipelineId(campus),properties};
}

test("dedicated Notion status reads both exact pipelines without reading applicants or writing",async t=>{
  tokenForTest(t,"test-token-with-sufficient-length");
  const calls=[];
  const checks=await productionNotionStatus(async(url,init)=>{
    calls.push(url);
    assert.equal(init.method,undefined);
    assert.equal(init.cache,"no-store");
    assert.equal(init.headers["Notion-Version"],"2022-06-28");
    const campus=url.endsWith(campusPipelineId("BU"))?"BU":"BC";
    return Response.json(database(campus));
  });
  assert.equal(calls.length,2);
  assert.ok(checks.every(check=>check.readable && check.schemaReady));
  assert.doesNotMatch(JSON.stringify(checks),/test-token|properties/);
});

test("Notion checks fail closed on missing secrets, wrong database, schema drift and provider failures",async t=>{
  tokenForTest(t,"");
  assert.ok((await productionNotionStatus(()=>{throw Error("must not call");})).every(c=>c.errorCode==="notion_not_configured"));
  process.env.INTERVIEW_NOTION_LIVE_TOKEN="test-token-with-sufficient-length";
  for(const mode of ["wrong_id","archived","wrong_type","missing_option","forbidden","rate_limit","timeout"]) {
    const checks=await productionNotionStatus(async url=>{
      if(mode==="forbidden")return new Response(null,{status:403});
      if(mode==="rate_limit")return new Response(null,{status:429});
      if(mode==="timeout")throw Error("secret-detail");
      const body=database(url.endsWith(campusPipelineId("BU"))?"BU":"BC");
      if(mode==="wrong_id")body.id="f".repeat(32);
      if(mode==="archived")body.archived=true;
      if(mode==="wrong_type")body.properties["Scheduling Reservation ID"].type="number";
      if(mode==="missing_option")body.properties["Interview Status"].select.options=[];
      return Response.json(body);
    });
    assert.ok(checks.every(c=>!c.schemaReady),mode);
    assert.doesNotMatch(JSON.stringify(checks),/secret-detail/);
  }
});
