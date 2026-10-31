import test from 'node:test';
import assert from 'node:assert/strict';
import {loadInterviewModule} from './interview-test-loader.mjs';
test('same-time slots identify the assigned interviewers by name',async()=>{
  const availability=loadInterviewModule('interview-availability');const week=availability.mondayForDate('2099-11-02');
  const db=async(strings)=>{const sql=strings.join('?');
    if(sql.includes('FROM interview.invitation'))return [{id:'invite',campus:'BC',notion_page_id:'synthetic-test'}];
    if(sql.includes('FROM interview.interviewer i'))return ['Bob','Second interviewer'].map((name,index)=>({interviewer_id:String(index),display_name:name,workspace_email:'bob@campus2care.org',week_start:week,weekly_capacity_limit:10,confirmed_at:new Date(),effective_windows:[{weekday:0,windows:[{startMinute:840,endMinute:860}]}],date_overrides:[]}));
    return [];
  };
  const service=loadInterviewModule('interview-slots',{'./interview-db':{interviewDatabase:()=>db,requireInterviewStagingBooking:()=>{}}});
  const slots=await service.listStagingInterviewSlots('a'.repeat(43));assert.equal(slots.length,2);
  assert.deepEqual(slots.map(s=>s.interviewerName),['Bob','Second interviewer']);assert.equal(slots[0].startsAt,slots[1].startsAt);
});
