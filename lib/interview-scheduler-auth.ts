import {timingSafeEqual} from "node:crypto";
export function interviewSchedulerAuthorized(header:string|null):boolean{
  const secret=process.env.INTERVIEW_STAGING_SCHEDULER_SECRET??"";
  if(process.env.VERCEL_ENV!=="preview"||secret.length<40||!header?.startsWith("Bearer "))return false;
  const actual=Buffer.from(header.slice(7)),expected=Buffer.from(secret);
  return actual.length===expected.length&&timingSafeEqual(actual,expected);
}
