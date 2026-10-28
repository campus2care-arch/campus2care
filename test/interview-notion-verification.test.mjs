import test from 'node:test';
import assert from 'node:assert/strict';
import {loadInterviewModule} from './interview-test-loader.mjs';
const service=loadInterviewModule('interview-notion-verification');
function setup(){Object.assign(process.env,{VERCEL_ENV:'preview',INTERVIEW_NOTION_READS_ENABLED:'true',INTERVIEW_NOTION_WRITES_ENABLED:'true',INTERVIEW_NOTION_BU_STAGING_DB_ID:'a'.repeat(32),INTERVIEW_NOTION_BC_STAGING_DB_ID:'b'.repeat(32),INTERVIEW_NOTION_STAGING_TOKEN:'synthetic-notion-token-long-enough'});}
function fixture(fail=false){
 const pages=new Map();for(const [campus,id,parent] of [['BU','407d6c55-a9de-8194-b14d-e7f70cc5ed22','a'],['BC','407d6c55-a9de-815c-9363-d831bece88f2','b']])pages.set(id.replaceAll('-',''),{id,parent:{database_id:parent.repeat(32)},properties:{Email:{email:`scheduling-${campus.toLowerCase()}@example.invalid`},'Scheduling Reservation ID':{rich_text:[]},'Interviewed By':{},'Interview Date':{date:null},'Interview Status':{select:{name:'Not Scheduled'}},'Google Meet URL':{url:null},'Executive Associate Owner':{select:{name:'preserve'}},Availability:{rich_text:[{plain_text:'placement sentinel'}]},'Interview Notes':{rich_text:[{plain_text:'history sentinel'}]}}});
 const transport=async(url,init={})=>{const page=pages.get(url.split('/').pop().replaceAll('-',''));if(init.method==='PATCH'){if(fail)return new Response(null,{status:503});const {properties}=JSON.parse(init.body);for(const [key,value]of Object.entries(properties)){if(value.rich_text)value.rich_text=value.rich_text.map(x=>({plain_text:x.text.content}));page.properties[key]=value;}}return Response.json(page);};return {transport,pages};
}
test('both campus synthetic fixtures schedule, cancel and preserve assignments and notes',async()=>{setup();const f=fixture();assert.deepEqual(await service.verifySyntheticNotionPipelines(f.transport),[{campus:'BU',scheduled:true,cleaned:true,preserved:true},{campus:'BC',scheduled:true,cleaned:true,preserved:true}]);});
test('provider failure is never reported as a successful Notion test',async()=>{setup();await assert.rejects(service.verifySyntheticNotionPipelines(fixture(true).transport),/notion_sync_patch_failed/);});
