import {NextRequest,NextResponse} from "next/server";
import {productionSchedulerAuthorized} from "../../../../../lib/interview-production-launch";
import {latestProductionHeartbeat,runProductionInterviewScheduler} from "../../../../../lib/interview-production-scheduler";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
const headers={"Cache-Control":"no-store","Referrer-Policy":"no-referrer",
  "X-Content-Type-Options":"nosniff"};
const reply=(status:number,body:object)=>NextResponse.json(body,{status,headers});

/** HTTPS-only external cron entrypoint. Never accepts individual email targets. */
export async function POST(request:NextRequest){
  if(process.env.VERCEL_ENV!=="production" ||
     !productionSchedulerAuthorized(request.headers.get("authorization")))
    return reply(403,{ok:false,error:"production_scheduler_not_authorized"});
  // The scheduler has no inbound payload; all eligible work is from exact
  // founder-approved DB manifests and immutable campaign run keys.
  if(request.headers.get("content-length") &&
     Number(request.headers.get("content-length"))>0)
    return reply(400,{ok:false,error:"scheduler_request_body_forbidden"});
  try {
    const outcome=await runProductionInterviewScheduler(new Date());
    // A blocked campaign is an operational status, not an HTTP transport failure.
    // Return non-2xx only when the scheduler actually throws, avoiding false cron retries.
    return reply(200,{ok:true,...outcome});
  }catch{
    return reply(503,{ok:false,error:"production_scheduler_unavailable"});
  }
}
/** Monitoring never invokes the worker or accepts anonymous requests. */
export async function GET(request:NextRequest){
  if(process.env.VERCEL_ENV!=="production" ||
     !productionSchedulerAuthorized(request.headers.get("authorization")))
    return reply(403,{ok:false,error:"production_scheduler_not_authorized"});
  let heartbeat=null;
  try{heartbeat=await latestProductionHeartbeat();}catch{
    return reply(503,{ok:false,error:"heartbeat_unavailable"});
  }
  return reply(200,{ok:true,active:process.env.INTERVIEW_PRODUCTION_SCHEDULER_ENABLED==="true",
    applicantCampaignsActive:process.env.INTERVIEW_PRODUCTION_APPLICANT_CAMPAIGNS_ENABLED==="true"&&
      process.env.INTERVIEW_REAL_APPLICANT_SENDS_APPROVED==="true",
    remindersActive:process.env.INTERVIEW_REAL_REMINDERS_APPROVED==="true",
    staffEmailsActive:process.env.INTERVIEW_REAL_STAFF_EMAILS_APPROVED==="true",
    heartbeat});
}
