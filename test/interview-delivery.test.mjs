import test from 'node:test';
import assert from 'node:assert/strict';
import {loadInterviewModule} from './interview-test-loader.mjs';
const mail=loadInterviewModule('interview-email');
const policy=loadInterviewModule('interview-dispatch-policy');
const sample={operationKey:'synthetic-mail:confirmation:001',recipient:'student@example.invalid',kind:'confirmation',campus:'BU',startsAt:'2026-11-02T19:00:00.000Z',meetUrl:'https://meet.google.com/abc-defg-hij'};
const setup=()=>{process.env.VERCEL_ENV='preview';process.env.INTERVIEW_SYNTHETIC_GMAIL_ENABLED='true';process.env.INTERVIEW_BASE_URL='https://staging.example.com';};
test('confirmation requires Meet and formats Boston time after DST change',()=>{
  setup();const output=mail.renderInterviewMessage(sample);assert.match(output.text,/2:00 PM Eastern Time/);assert.match(output.text,/BU/);assert.match(output.text,/20 minutes/);
  assert.throws(()=>mail.renderInterviewMessage({...sample,meetUrl:undefined}),/confirmation_requires_meet/);
  assert.throws(()=>mail.renderInterviewMessage({...sample,link:'https://evil.example/interview'}),/invalid_message_link/);
});
test('staging MIME forces Bob and authorized sender; deterministic ID is stable',async()=>{
  setup();const sent=[];
  const transport=async(url,init)=>{assert.match(url,/gmail/);const mime=Buffer.from(JSON.parse(init.body).raw,'base64url').toString();sent.push(mime);return Response.json({id:'synthetic-id'});};
  await mail.sendStagingInterviewMessage(sample,'synthetic-access-token-long-enough',transport);
  await mail.sendStagingInterviewMessage(sample,'synthetic-access-token-long-enough',transport);
  assert.match(sent[0],/To: bob@campus2care.org/);assert.match(sent[0],/From: Campus2Care <contact@campus2care.org>/);
  assert.equal(sent[0],sent[1]);assert.doesNotMatch(sent[0],/student@example.invalid/);
});
test('real audiences and production fail before network access',async()=>{
  setup();let calls=0;const transport=async()=>{calls++;return Response.json({id:'wrong'});};
  await assert.rejects(mail.sendStagingInterviewMessage({...sample,recipient:'real@gmail.com'},'test-token-long-enough',transport),/real_recipient_forbidden/);
  process.env.VERCEL_ENV='production';await assert.rejects(mail.sendStagingInterviewMessage(sample,'test-token-long-enough',transport),/interview_mail_disabled/);assert.equal(calls,0);
});
test('Gmail timeout, malformed success, 429 and 503 retain distinct ambiguity',async()=>{
  setup();for(const [transport,ambiguous] of [
    [async()=>{throw Error('timeout');},true],[async()=>Response.json({}),true],
    [async()=>new Response(null,{status:429}),false],[async()=>new Response(null,{status:503}),true],
  ])await assert.rejects(mail.sendStagingInterviewMessage(sample,'test-token-long-enough',transport),(e)=>e.ambiguous===ambiguous);
});
test('dispatch times follow local Eastern time on both sides of DST',()=>{
  assert.equal(policy.dueInterviewDispatches(new Date('2026-10-28T18:59:00Z')).length,0);
  assert.equal(policy.dueInterviewDispatches(new Date('2026-10-28T19:00:00Z'))[0].kind,'ea_request');
  assert.equal(policy.dueInterviewDispatches(new Date('2026-11-04T19:59:00Z')).length,0);
  assert.equal(policy.dueInterviewDispatches(new Date('2026-11-04T20:00:00Z'))[0].kind,'ea_request');
  assert.equal(policy.dueInterviewDispatches(new Date('2026-11-01T22:00:00Z'))[0].weekStart,'2026-11-02');
  assert.equal(policy.dueInterviewDispatches(new Date('2026-11-02T14:00:00Z'))[0].weekStart,'2026-11-02');
  assert.deepEqual(policy.dueInterviewDispatches(new Date('2026-11-06T19:00:00Z')).map(x=>x.kind),['leadership_escalation','applicant_friday']);
});
test('48-hour spacing, seven-day cap, unresolved sends, exact boundary',()=>{
  const now=Date.parse('2026-11-02T14:00:00Z');const sent=(hours)=>({state:'sent',sentAt:new Date(now-hours*3600000).toISOString(),createdAt:new Date(now-hours*3600000).toISOString()});
  assert.equal(policy.routineOutreachDecision([sent(21)],now),'spacing_48_hours');
  assert.equal(policy.routineOutreachDecision([sent(48)],now),'eligible');
  assert.equal(policy.routineOutreachDecision([sent(49),sent(120)],now),'rolling_week_limit');
  assert.equal(policy.routineOutreachDecision([{state:'reconcile_required',sentAt:null,createdAt:new Date(now).toISOString()}],now),'unresolved_prior_message');
});
