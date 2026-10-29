import test from 'node:test';import assert from 'node:assert/strict';import {loadInterviewModule} from './interview-test-loader.mjs';
const lib=loadInterviewModule('interview-launch-review'),policy=loadInterviewModule('interview-dispatch-policy');
const now=new Date('2026-10-29T12:45:00Z');
const applicant=(email,extra={})=>({email,campus:'BU',name:'Student',recordUrl:'https://notion.so/'+email,interviewDate:null,stage:'Needs Interview',nextStep:'Schedule interview',interviewStatus:'Not Scheduled',workflowStatus:'Application Received',...extra});
test('October 29 one-time review leaves ordinary weekly schedules unchanged',()=>{
 assert.equal(lib.october29LaunchKey(now),'applicant_founder_launch:2026-10-29');
 assert.deepEqual(policy.dueInterviewDispatches(now),[]);
 assert.throws(()=>lib.october29LaunchKey(new Date('2026-10-30T12:45:00Z')),/date_mismatch/);
 assert.ok(policy.dueInterviewDispatches(new Date('2026-10-30T18:05:00Z')).some(r=>r.kind==='applicant_friday'));
});
test('dry run suppresses old bookings, completed cross-campus identities, opt-outs, and recent mail',()=>{
 const rows=[applicant('booked@bu.edu'),applicant('past@bu.edu'),applicant('past@bu.edu',{campus:'BC',interviewStatus:'Completed',recordUrl:'other'}),applicant('out@bu.edu'),applicant('recent@bu.edu'),applicant('ok@bu.edu')];
 const review=lib.reviewOctober29Recipients({now,applicants:rows,previouslyBookedEmails:['booked@bu.edu'],optedOutEmails:['out@bu.edu'],history:{'recent@bu.edu':[{state:'sent',sentAt:'2026-10-28T14:00:00Z',createdAt:'2026-10-28T14:00:00Z'}]}});
 assert.deepEqual(Object.fromEntries(review.map(r=>[r.email,r.decision])),{'booked@bu.edu':'prior_interview_or_booking','past@bu.edu':'prior_interview_or_booking','out@bu.edu':'opted_out','recent@bu.edu':'spacing_48_hours','ok@bu.edu':'eligible_for_release_review'});
});
test('cross-campus duplicate and rolling seven-day cap remain enforced in one-time review',()=>{
 const r=lib.reviewOctober29Recipients({now,applicants:[applicant('same@bu.edu'),applicant('same@bu.edu',{campus:'BC',recordUrl:'z'}),applicant('cap@bu.edu')],previouslyBookedEmails:[],optedOutEmails:[],history:{'cap@bu.edu':[{state:'sent',sentAt:'2026-10-23T14:00:00Z',createdAt:'2026-10-23T14:00:00Z'},{state:'sent',sentAt:'2026-10-26T14:00:00Z',createdAt:'2026-10-26T14:00:00Z'}]}});
 assert.equal(r.filter(x=>x.email==='same@bu.edu'&&x.decision==='eligible_for_release_review').length,1);
 assert.ok(r.some(x=>x.decision==='duplicate_across_pipelines'));assert.ok(r.some(x=>x.decision==='rolling_week_limit'));
});
