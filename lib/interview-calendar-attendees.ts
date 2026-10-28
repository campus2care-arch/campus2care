import {interviewDatabase} from './interview-db';
/** The staging attendee pilot can address only Bob and an undeliverable synthetic applicant. */
export async function syntheticCalendarAttendees(interviewerId:string):Promise<string[]|undefined>{
  if(process.env.VERCEL_ENV!=='preview'||process.env.INTERVIEW_SYNTHETIC_ATTENDEES_ENABLED!=='true')return undefined;
  const rows=await interviewDatabase()<{workspace_email:string}[]>`SELECT workspace_email FROM interview.interviewer WHERE id=${interviewerId}`;
  if(rows[0]?.workspace_email!=='bob@campus2care.org')throw new Error('synthetic_attendee_interviewer_required');
  return ['bob@campus2care.org','synthetic@example.invalid'];
}
