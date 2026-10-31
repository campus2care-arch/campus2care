import test from 'node:test';
import assert from 'node:assert/strict';
import {loadInterviewModule} from './interview-test-loader.mjs';
const policy=loadInterviewModule('interview-dispatch-policy');
const now=Date.parse('2026-11-01T12:00:00Z');
const sent=h=>({state:'sent',sentAt:new Date(now-h*3600000).toISOString(),createdAt:new Date(now-h*3600000).toISOString()});

test('unset or malformed limits keep the original 48h / two-per-week policy',()=>{
  assert.deepEqual(policy.outreachFrequencyPolicy({}),{minSpacingHours:48,maxPerRollingWeek:2});
  assert.deepEqual(policy.outreachFrequencyPolicy({INTERVIEW_FOLLOWUP_MIN_SPACING_HOURS:'abc',INTERVIEW_FOLLOWUP_MAX_PER_7_DAYS:'-1'}),
    {minSpacingHours:48,maxPerRollingWeek:2});
});
test('limits are configurable and 0 turns a limit off',()=>{
  const off=policy.outreachFrequencyPolicy({INTERVIEW_FOLLOWUP_MIN_SPACING_HOURS:'0',INTERVIEW_FOLLOWUP_MAX_PER_7_DAYS:'0'});
  assert.equal(policy.routineOutreachDecision([sent(1),sent(30)],now,off),'eligible');
  const tight=policy.outreachFrequencyPolicy({INTERVIEW_FOLLOWUP_MIN_SPACING_HOURS:'72',INTERVIEW_FOLLOWUP_MAX_PER_7_DAYS:'1'});
  assert.equal(policy.routineOutreachDecision([sent(60)],now,tight),'spacing_48_hours');
  assert.equal(policy.routineOutreachDecision([sent(100)],now,tight),'rolling_week_limit');
  assert.equal(policy.outreachHistoryLookbackHours({minSpacingHours:240,maxPerRollingWeek:2}),240);
});
test('founder exception waives frequency limits but never an unresolved prior send',()=>{
  const strict={minSpacingHours:48,maxPerRollingWeek:2};
  assert.equal(policy.routineOutreachDecision([sent(1),sent(5)],now,strict,{frequencyException:true}),'eligible');
  const pending={state:'reconcile_required',sentAt:null,createdAt:new Date(now).toISOString()};
  assert.equal(policy.routineOutreachDecision([pending],now,strict,{frequencyException:true}),'unresolved_prior_message');
  assert.equal(policy.routineOutreachDecision([{state:'queued',sentAt:null,createdAt:new Date(now).toISOString()}],now,
    {minSpacingHours:0,maxPerRollingWeek:0}),'unresolved_prior_message');
});
