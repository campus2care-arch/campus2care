import {NextRequest,NextResponse} from "next/server";
import {staffFromRequest} from "../../../../../lib/interview-auth";
import {requireProductionAudienceReview,scanProductionApplicantPipelines} from "../../../../../lib/interview-production-applicant-review";
import {productionAudienceReviewDatabase} from "../../../../../lib/interview-production-audience-facts";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
const headers={"Cache-Control":"private, no-store","Referrer-Policy":"no-referrer",
  "X-Content-Type-Options":"nosniff"};
/** Founder-only campaign status, including named held records for reconciliation. */
export async function GET(request:NextRequest){
  if(process.env.VERCEL_ENV!=="production")
    return NextResponse.json({ok:false,error:"not_found"},{status:404,headers});
  const identity=staffFromRequest(request);
  if(identity?.role!=="admin"||identity.email!=="president@campus2care.org")
    return NextResponse.json({ok:false,error:"founder_access_required"},{status:403,headers});
  try {
    requireProductionAudienceReview();
    const deadline=Date.now()+50_000;
    const db=productionAudienceReviewDatabase();
    const rows=await db.unsafe<{
      run_key:string;state:string;approved_at:Date;expires_at:Date;expected_count:number;
      queued:number;sent:number;suppressed:number;reconciliation:number;pending:number;
    }[]>(
      "SELECT m.run_key,m.state,m.approved_at,m.expires_at,m.expected_count,"+
      "count(*) FILTER (WHERE r.state='queued')::int AS queued,"+
      "count(*) FILTER (WHERE r.state='sent')::int AS sent,"+
      "count(*) FILTER (WHERE r.state='suppressed')::int AS suppressed,"+
      "count(*) FILTER (WHERE r.state='reconcile_required')::int AS reconciliation,"+
      "count(*) FILTER (WHERE r.state='approved')::int AS pending "+
      "FROM interview.applicant_campaign_manifest m "+
      "JOIN interview.applicant_campaign_recipient r ON r.manifest_id=m.id "+
      "GROUP BY m.id,m.run_key,m.state,m.approved_at,m.expires_at,m.expected_count "+
      "ORDER BY m.approved_at DESC LIMIT 12",[]);
    const heldRows=await db.unsafe<{
      run_key:string;campus:"BU"|"BC";page_id:string;email:string;
      error_code:string|null;error_class:string|null;http_status:number|null;
      outbox_state:string;gmail_message_id:string|null;
    }[]>(
      "SELECT m.run_key,r.campus,r.page_id,c.email,j.last_error_code AS error_code,"+
      "NULLIF(j.payload_ref->>'errorClass','') AS error_class,"+
      "CASE WHEN (j.payload_ref->>'httpStatus') ~ '^[1-5][0-9]{2}$' "+
      "THEN (j.payload_ref->>'httpStatus')::int ELSE NULL END AS http_status,"+
      "j.state AS outbox_state,j.external_id AS gmail_message_id "+
      "FROM interview.applicant_campaign_manifest m "+
      "JOIN interview.applicant_campaign_recipient r ON r.manifest_id=m.id "+
      "JOIN interview.invitation i ON i.id=r.invitation_id "+
      "JOIN interview.applicant_contact c ON c.invitation_id=i.id "+
      "JOIN interview.message msg ON msg.object_id=i.id AND msg.kind='invitation' "+
      "JOIN interview.integration_outbox j ON j.object_id=msg.id AND j.provider='gmail' "+
      "AND j.action='send_message' "+
      "WHERE r.state='reconcile_required' ORDER BY m.approved_at DESC,r.campus,r.page_id LIMIT 100",[]);
    const deliveryFailures=await db.unsafe<{
      run_key:string;error_code:string;error_class:string|null;http_status:number|null;count:number;
    }[]>(
      "SELECT split_part(j.operation_key,':',2)||':'||split_part(j.operation_key,':',3)||"+
      "CASE WHEN split_part(j.operation_key,':',4) ~ '^[1-9][0-9]?$' THEN ':'||split_part(j.operation_key,':',4) ELSE '' END AS run_key,"+
      "j.last_error_code AS error_code,NULLIF(j.payload_ref->>'errorClass','') AS error_class,"+
      "CASE WHEN (j.payload_ref->>'httpStatus') ~ '^[1-5][0-9]{2}$' "+
      "THEN (j.payload_ref->>'httpStatus')::int ELSE NULL END AS http_status,count(*)::int AS count "+
      "FROM interview.integration_outbox j "+
      "WHERE j.provider='gmail' AND j.action='send_message' AND j.state='failed' "+
      "AND j.operation_key LIKE 'campaign-invite:applicant_%' AND j.external_id IS NULL "+
      "AND j.last_error_code IS NOT NULL "+
      "GROUP BY 1,2,3,4 ORDER BY count DESC LIMIT 20",[]);
    const applicants=await scanProductionApplicantPipelines(fetch,process.env,deadline);
    const applicantByPage=new Map(applicants.map(person=>[person.campus+":"+person.pageId,person]));
    return NextResponse.json({ok:true,campaigns:rows.map(r=>({
      runKey:r.run_key,state:r.state,approvedAt:r.approved_at.toISOString(),
      expiresAt:r.expires_at.toISOString(),expectedCount:r.expected_count,
      queued:r.queued,sent:r.sent,suppressed:r.suppressed,reconciliation:r.reconciliation,
      pending:r.pending
    })),reconcileRecipients:heldRows.map(row=>({
      runKey:row.run_key,campus:row.campus,pageId:row.page_id,
      name:applicantByPage.get(row.campus+":"+row.page_id)?.name??"Name unavailable",
      email:row.email,errorCode:row.error_code??"send_outcome_unknown",
      errorClass:row.error_class,httpStatus:row.http_status,
      outboxState:row.outbox_state,gmailMessageId:row.gmail_message_id
    })),deliveryFailures:deliveryFailures.map(row=>({
      runKey:row.run_key,errorCode:row.error_code,errorClass:row.error_class,
      httpStatus:row.http_status,count:row.count
    }))},{headers});
  }catch{
    return NextResponse.json({ok:false,error:"campaign_status_unavailable"},
      {status:503,headers});
  }
}
