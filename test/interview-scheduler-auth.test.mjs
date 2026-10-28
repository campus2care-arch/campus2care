import test from 'node:test';
import assert from 'node:assert/strict';
import {loadInterviewModule} from './interview-test-loader.mjs';
const auth=loadInterviewModule('interview-scheduler-auth');
test('scheduler requires preview and exact strong bearer credential',()=>{
  process.env.VERCEL_ENV='preview';process.env.INTERVIEW_STAGING_SCHEDULER_SECRET='x'.repeat(64);
  assert.equal(auth.interviewSchedulerAuthorized('Bearer '+'x'.repeat(64)),true);
  for(const value of [null,'Bearer short','Basic '+'x'.repeat(64),'Bearer '+'y'.repeat(64)])assert.equal(auth.interviewSchedulerAuthorized(value),false);
  process.env.VERCEL_ENV='production';assert.equal(auth.interviewSchedulerAuthorized('Bearer '+'x'.repeat(64)),false);
  process.env.VERCEL_ENV='preview';delete process.env.INTERVIEW_STAGING_SCHEDULER_SECRET;assert.equal(auth.interviewSchedulerAuthorized('Bearer '+'x'.repeat(64)),false);
});
