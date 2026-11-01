import {NextRequest,NextResponse} from "next/server";
import {staffFromRequest,interviewBaseOrigin} from "../../../../../lib/interview-auth";
import {productionInterviewDatabase} from "../../../../../lib/interview-production-db";
import {applicantCampaignSendingAuthorized,queueApprovedApplicantCampaign} from "../../../../../lib/interview-production-campaign-queue";
import {processProductionCampaignOutbox} from "../../../../../lib/interview-production-campaign-mail";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
const headers={"Cache-Control":"no-store, private","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff"};
const reply=(status:number,data:object)=>NextResponse.json(data,{status,headers});

/** Founder-only, exact-manifest send action. Never generates a new audience or overrides a release gate.
 * One call safely queues at most 20 and sends at most five; subsequent requests resume idempotently.
 * The ordinary hourly scheduler resumes already-running manual batches if the founder closes the tab.
 */
export async function POST(request:NextRequest) {
  if(process.env.VERCEL_ENV!=="production")return reply(404,{ok:false,error:"production_only"});
  const staff=staffFromRequest(request);
  if(staff?.role!=="admin"||staff.email!=="president@campus2care.org")
    return reply(403,{ok:false,error:"founder_access_required"});
  if(request.headers.get("origin")!==interviewBaseOrigin(request)||
     !request.headers.get("content-type")?.startsWith("application/json"))
    return reply(403,{ok:false,error:"invalid_request_origin"});
  let runKey:string;
  try{
    const data=await request.json() as {runKey?:unknown};
    if(typeof data?.runKey!=="string"||
       !/^applicant_manual:\d{4}-\d{2}-\d{2}:[1-9][0-9]?$/.test(data.runKey))
      return reply(400,{ok:false,error:"manual_campaign_key_invalid"});
    runKey=data.runKey;
  }catch{return reply(400,{ok:false,error:"invalid_request"});}
  try{
    applicantCampaignSendingAuthorized();
    const db=productionInterviewDatabase();
    const records=await db.unsafe<{state:string;expires_at:Date;approved_by:string}[]>(
      "SELECT state,expires_at,approved_by FROM interview.applicant_campaign_manifest WHERE run_key=$1",
      [runKey]);
    const manifest=records[0];
    if(!manifest||manifest.approved_by!=="president@campus2care.org"||
      manifest.expires_at.getTime()<=Date.now()||
      !["approved","running"].includes(manifest.state))
      return reply(409,{ok:false,error:"campaign_not_approved_or_expired"});
    const queued=await queueApprovedApplicantCampaign(new Date(),{db,manualRunKey:runKey});
    const processed=await processProductionCampaignOutbox(db,5);
    const counts=await db.unsafe<{state:string;count:number}[]>(
      "SELECT r.state,count(*)::int AS count FROM interview.applicant_campaign_recipient r "+
      "JOIN interview.applicant_campaign_manifest m ON m.id=r.manifest_id "+
      "WHERE m.run_key=$1 GROUP BY r.state ORDER BY r.state",[runKey]);
    return reply(200,{ok:true,runKey,queued:queued.queued,skipped:queued.skipped,
      blocked:queued.blocked,sent:processed.sent,reconciliation:processed.reconciliation,
      counts:Object.fromEntries(counts.map(x=>[x.state,x.count]))});
  }catch{return reply(503,{ok:false,error:"campaign_send_unavailable_or_not_authorized"});}
}
