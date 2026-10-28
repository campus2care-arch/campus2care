import test from 'node:test';
import assert from 'node:assert/strict';
import {loadInterviewModule} from './interview-test-loader.mjs';
const sync=loadInterviewModule('interview-notion-sync');
const bu='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',bc='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',page='cccccccccccccccccccccccccccccccc';
const input={campus:'BU',pageId:page,reservationId:'dddddddd-dddd-dddd-dddd-dddddddddddd',status:'confirmed',startsAt:'2026-11-02T19:00:00.000Z',meetUrl:'https://meet.google.com/abc-defg-hij',interviewerEmail:'bob@campus2care.org'};
function setup(){Object.assign(process.env,{VERCEL_ENV:'preview',INTERVIEW_NOTION_READS_ENABLED:'true',INTERVIEW_NOTION_WRITES_ENABLED:'true',INTERVIEW_NOTION_BU_STAGING_DB_ID:bu,INTERVIEW_NOTION_BC_STAGING_DB_ID:bc,INTERVIEW_NOTION_STAGING_TOKEN:'synthetic-token-that-is-long-enough'});}
function response(parent=bu,email='student@example.invalid',current=''){
  return {id:page,parent:{database_id:parent},properties:{Email:{email},'Scheduling Reservation ID':{rich_text:[{plain_text:current}]},'Interviewed By':{},'Google Meet URL':{},'Interview Date':{},'Interview Status':{},'Executive Associate Owner':{select:{name:'Preserve me'}}}};
}
test('Notion patch preserves caseload ownership, placement availability and notes',async()=>{
  setup();let patch;
  await sync.syncSyntheticNotionInterview(input,async(url,init)=>{if(init.method==='PATCH'){patch=JSON.parse(init.body);return Response.json({id:page});}return Response.json(response());});
  assert.equal(patch.properties['Interviewed By'].rich_text[0].text.content,'bob@campus2care.org');
  assert.equal(patch.properties['Executive Associate Owner'],undefined);assert.equal(patch.properties.Availability,undefined);assert.equal(patch.properties['Interview Notes'],undefined);
});
test('wrong campus, real address, newer booking and incomplete schema block all writes',async()=>{
  setup();for(const value of [response(bc),response(bu,'real@gmail.com'),response(bu,'student@example.invalid','newer-booking'),{...response(),properties:{Email:{email:'student@example.invalid'}}}]){
    let writes=0;await assert.rejects(sync.syncSyntheticNotionInterview(input,async(url,init)=>{if(init.method==='PATCH')writes++;return Response.json(value);}));assert.equal(writes,0);
  }
});
test('production database IDs cannot be configured as staging clones',async()=>{
  setup();process.env.INTERVIEW_NOTION_BU_STAGING_DB_ID='03192649741442fe86acdddcc7320798';
  await assert.rejects(sync.syncSyntheticNotionInterview(input,async()=>{throw Error('must not call');}),/production_notion_database_forbidden/);
});
test('Notion 429 and 5xx are visible failures instead of a false success',async()=>{
  setup();for(const status of [429,503])await assert.rejects(sync.syncSyntheticNotionInterview(input,async(url,init)=>init.method==='PATCH'?new Response(null,{status}):Response.json(response())),/notion_sync_/);
});
