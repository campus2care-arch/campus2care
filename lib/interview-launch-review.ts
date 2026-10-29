import {evaluateInitialInterviewEligibility,type Campus,type ApplicantInterviewState} from './interview-notion-contract';
import {routineOutreachDecision,type RoutineAttempt} from './interview-dispatch-policy';
import {instantToEasternLocal} from './interview-timezone';
export type LaunchApplicant=ApplicantInterviewState & {campus:Campus;name:string;recordUrl:string;interviewDate:string|null};
export type LaunchRecipientReview={email:string;campus:Campus;name:string;recordUrl:string;decision:string;eligibleAfter:string|null};
/** A one-off evaluation key does not modify the recurring Friday/Sunday/Monday policy. */
export function october29LaunchKey(now:Date):string{
 if(instantToEasternLocal(now).date!== '2026-10-29')throw Error('one_time_launch_date_mismatch');
 return 'applicant_founder_launch:2026-10-29';
}
/** Read-only preparation; this function never enrolls, rotates tokens, queues, or sends. */
export function reviewOctober29Recipients(input:{now:Date;applicants:LaunchApplicant[];previouslyBookedEmails:string[];optedOutEmails:string[];history:Record<string,RoutineAttempt[]>}):LaunchRecipientReview[]{
 october29LaunchKey(input.now);
 const normalize=(email:string)=>(email??"").trim().toLowerCase();
 const prior=new Set(input.previouslyBookedEmails.map(normalize));
 for(const applicant of input.applicants)if(applicant.interviewDate||['Scheduled','Completed'].includes(applicant.interviewStatus??''))prior.add(normalize(applicant.email));
 const optouts=new Set(input.optedOutEmails.map(normalize)),seen=new Set<string>();
 const reviews:LaunchRecipientReview[]=[];
 for(const applicant of [...input.applicants].sort((a,b)=>a.recordUrl.localeCompare(b.recordUrl))){
  const email=normalize(applicant.email),eligibility=evaluateInitialInterviewEligibility(applicant.campus,{...applicant,email});
  // Include only pipeline candidates in this launch review; all other records remain untouched.
  if(!eligibility.eligible)continue;
  let decision='eligible_for_release_review';
  if(/@example\.invalid$/.test(email)||/synthetic|\bqa\b/i.test(applicant.name))decision='synthetic_record_excluded';
  else if(prior.has(email))decision='prior_interview_or_booking';
  else if(optouts.has(email))decision='opted_out';
  else if(seen.has(email))decision='duplicate_across_pipelines';
  else {const spacing=routineOutreachDecision(input.history[email]??[],input.now.getTime());if(spacing!=='eligible')decision=spacing;}
  seen.add(email);
  const latest=Math.max(0,...(input.history[email]??[]).filter(h=>h.state==='sent'&&h.sentAt).map(h=>Date.parse(h.sentAt!)).filter(Number.isFinite));
  reviews.push({email,campus:applicant.campus,name:applicant.name,recordUrl:applicant.recordUrl,decision,eligibleAfter:decision==='spacing_48_hours'?new Date(latest+48*3600000).toISOString():null});
 }
 return reviews;
}
