import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const data=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
const compile=async p=>ts.transpileModule(await readFile(new URL('../lib/'+p,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const providerUrl=data(await compile('interview-calendar-provider.ts'));
const lifecycleUrl=data((await compile('interview-calendar-verification.ts')).replace('from "./interview-calendar-provider"','from "'+providerUrl+'"'));
const lifecycle=await import(lifecycleUrl);
const dbUrl=data(`import postgres from "${import.meta.resolve('postgres')}";const json=postgres().json;let row=null;export function reset(){row=null}export function current(){return row}const query=async(strings,...values)=>{const text=strings.join('?');if(text.includes('FROM interview.message'))return [{total:2}];if(text.includes('INSERT INTO interview.integration_outbox')){if(row)return [];row={id:values[0],operation_key:values[1],state:'processing',attempts:1,payload_ref:values[3].value,last_error_code:null};return [structuredClone(row)]}if(text.includes("SET state='processing'")){if(!row||row.state!=='reconcile_required')return [];row={...row,state:'processing',attempts:row.attempts+1};return [structuredClone(row)]}if(text.includes('SET payload_ref=')){row.payload_ref=values[0].value;return []}if(text.includes('SET state=')){row={...row,state:values[0],payload_ref:values[1].value,last_error_code:values[2]};return [structuredClone(row)]}if(text.includes('FROM interview.integration_outbox'))return row?[structuredClone(row)]:[];throw new Error('unexpected_query')};query.json=json;export function interviewDatabase(){return query}`);
const authUrl=data(`export async function googleProviderAccessToken(){return 'synthetic-server-access-token'};export function providerDetails(provider){return {email:provider==='calendar'?'interviews@campus2care.org':'contact@campus2care.org'}}`);
const controller=await import(data((await compile('interview-provider-verification.ts')).replace('from "./interview-db"','from "'+dbUrl+'"').replace('from "./interview-google-provider-auth"','from "'+authUrl+'"').replace('from "./interview-calendar-verification"','from "'+lifecycleUrl+'"')));
const db=await import(dbUrl);
const input={accessToken:'synthetic-server-access-token',operationKey:'synthetic-calendar-test-001',startsAt:'2026-11-02T15:00:00.000Z',endsAt:'2026-11-02T15:20:00.000Z'};
const id='fe5ce965-b77f-4242-b30b-eb41f52a84a8';
function setup({pending=0,loseCreate=false,failDelete=false}={}){
  process.env.VERCEL_ENV='preview';process.env.INTERVIEW_CALENDAR_WRITES_ENABLED='false';process.env.INTERVIEW_SYNTHETIC_CALENDAR_ENABLED='true';db.reset();
  const events=new Map();let posts=0,reads=0,deletes=0;let blockDelete=failDelete;
  const transport=async(url,init={})=>{
    const parsed=new URL(url),method=init.method??'GET';
    if(parsed.hostname==='openidconnect.googleapis.com')return Response.json({email:'interviews@campus2care.org',email_verified:true});
    if(!parsed.pathname.includes('/events'))throw new Error('unexpected_url');
    const eventId=parsed.pathname.split('/events/')[1];
    if(method==='GET'){
      reads++;const event=events.get(eventId);if(!event)return new Response(null,{status:404});
      if(event.status==='cancelled')return new Response(null,{status:410});
      if(reads>pending)event.conferenceData={entryPoints:[{entryPointType:'video',uri:'https://meet.google.com/abc-defg-hij'}]};
      return Response.json(event);
    }
    if(method==='POST'){
      posts++;const body=JSON.parse(init.body);assert.equal(body.attendees,undefined);assert.equal(parsed.searchParams.get('sendUpdates'),'none');
      const event={...body,status:'confirmed'};if(!pending)event.conferenceData={entryPoints:[{entryPointType:'video',uri:'https://meet.google.com/abc-defg-hij'}]};else delete event.conferenceData;
      events.set(body.id,event);if(loseCreate)throw new Error('synthetic_timeout_after_acceptance');return Response.json(event);
    }
    if(method==='DELETE'){
      deletes++;assert.equal(parsed.searchParams.get('sendUpdates'),'none');if(blockDelete)return new Response(null,{status:503});
      const event=events.get(eventId);if(event)event.status='cancelled';return new Response(null,{status:204});
    }
    throw new Error('unexpected_method');
  };
  return {transport,events,allowCleanup(){blockDelete=false},counts:()=>({posts,reads,deletes})};
}
test('synthetic lifecycle gets one individual Meet link and cancels its only event',async()=>{
  const f=setup();const result=await lifecycle.verifySyntheticCalendarLifecycle(input,f.transport,async r=>assert.equal(r.meetReady,true),async()=>undefined);
  assert.deepEqual(result,{idempotent:true,meetReady:true,canceled:true,errorCode:null});assert.equal(f.counts().posts,1);assert.equal([...f.events.values()][0].status,'cancelled');
});
test('pending conference is read until ready without creating another event',async()=>{
  const f=setup({pending:4});let waits=0;const result=await lifecycle.verifySyntheticCalendarLifecycle(input,f.transport,async()=>undefined,async()=>{waits++});
  assert.equal(result.meetReady,true);assert.ok(waits>0);assert.equal(result.canceled,true);assert.equal(f.counts().posts,1);
});
test('a timeout after Google accepts creation still triggers deterministic cleanup',async()=>{
  const f=setup({loseCreate:true});const result=await lifecycle.verifySyntheticCalendarLifecycle(input,f.transport,async()=>undefined,async()=>undefined);
  assert.equal(result.canceled,true);assert.equal(result.meetReady,false);assert.equal(f.counts().posts,1);assert.equal([...f.events.values()][0].status,'cancelled');
});
test('worker crash or failed cleanup can reconcile the same run without creating again',async()=>{
  const f=setup({failDelete:true});const first=await controller.runSyntheticCalendarVerification(id,false,f.transport);
  assert.equal(first.state,'reconcile_required');assert.equal(db.current().payload_ref.meetReady,true);assert.equal(f.counts().posts,1);
  f.allowCleanup();const second=await controller.runSyntheticCalendarVerification(id,true,f.transport);
  assert.equal(second.state,'done');assert.equal(second.canceled,true);assert.equal(f.counts().posts,1);
  const duplicate=await controller.runSyntheticCalendarVerification(id,false,f.transport);assert.equal(duplicate.state,'done');assert.equal(f.counts().posts,1);
});
test('synthetic opt-in does not activate production or the live flag',async()=>{
  setup();assert.equal(process.env.INTERVIEW_CALENDAR_WRITES_ENABLED,'false');process.env.INTERVIEW_SYNTHETIC_CALENDAR_ENABLED='false';
  await assert.rejects(controller.runSyntheticCalendarVerification(id),/disabled/);
  process.env.INTERVIEW_SYNTHETIC_CALENDAR_ENABLED='true';process.env.VERCEL_ENV='production';
  await assert.rejects(controller.runSyntheticCalendarVerification(id),/preview_only/);
});
test('connection check validates identity and never calls Gmail send',async()=>{
  setup();const calls=[];const result=await controller.providerVerificationStatus(async(url,init)=>{
    calls.push(url);assert.ok(!url.includes('/messages/send'));assert.equal(init.method??'GET','GET');
    if(url.includes('/events?'))return Response.json({kind:'calendar#events'});
    const prior=calls.filter(x=>x.includes('userinfo')).length;return Response.json({email:prior===1?'interviews@campus2care.org':'contact@campus2care.org',email_verified:true});
  });
  assert.equal(result.connections.every(x=>x.verified),true);assert.match(result.connections.find(x=>x.provider==='gmail').check,/2 staging messages accepted/);assert.equal(calls.length,3);
});
const routeAuth=data(`export function staffFromRequest(req){const role=req.headers.get('x-test-role');return role?{role,email:'synthetic-admin@campus2care.org'}:null}export function interviewBaseOrigin(){return 'https://preview.example.invalid'}`);
const next=data(`export const NextResponse={json:(body,init)=>new Response(JSON.stringify(body),init)}`);
const routeHandlers=data(`let count=0;export function mutations(){return count}export async function providerVerificationStatus(){return {connections:[],lastTest:null}}export async function runSyntheticCalendarVerification(id,cleanup){count++;return {runId:id,cleanup}}`);
const routeSource=ts.transpileModule(await readFile(new URL('../app/api/interview/admin/providers/route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText
 .replace('from "next/server"','from "'+next+'"').replace('from "../../../../../lib/interview-auth"','from "'+routeAuth+'"').replace('from "../../../../../lib/interview-provider-verification"','from "'+routeHandlers+'"');
const route=await import(data(routeSource)),routeMock=await import(routeHandlers);
function request(role,origin='https://preview.example.invalid',body=JSON.stringify({action:'verify_calendar',runId:id})){
 const headers={'content-type':'application/json',origin};if(role)headers['x-test-role']=role;
 return new Request('https://preview.example.invalid/api/interview/admin/providers',{method:'POST',headers,body});
}
test('verification endpoints enforce admin, preview and request-origin boundaries before provider mutations',async()=>{
 setup();assert.equal((await route.POST(request(null))).status,403);assert.equal((await route.POST(request('ea'))).status,403);
 assert.equal((await route.POST(request('admin','https://other.example.invalid'))).status,403);
 assert.equal((await route.POST(request('admin','https://preview.example.invalid','x'.repeat(2001)))).status,413);
 process.env.VERCEL_ENV='production';assert.equal((await route.POST(request('admin'))).status,403);assert.equal(routeMock.mutations(),0);
 process.env.VERCEL_ENV='preview';assert.equal((await route.POST(request('admin'))).status,200);assert.equal(routeMock.mutations(),1);
});
