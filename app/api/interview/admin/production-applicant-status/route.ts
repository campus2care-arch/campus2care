import {NextRequest,NextResponse} from "next/server";
import {staffFromRequest} from "../../../../../lib/interview-auth";
import {requireProductionAudienceReview} from "../../../../../lib/interview-production-applicant-review";
import {productionAudienceReviewDatabase} from "../../../../../lib/interview-production-audience-facts";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"private, no-store","Referrer-Policy":"no-referrer",
  "X-Content-Type-Options":"nosniff"};
/** Aggregate-only founder campaign status. Never return applicant emails or hashes. */
export async function GET(request:NextRequest){
  if(process.env.VERCEL_ENV!=="production")
    return NextResponse.json({ok:false,error:"not_found"},{status:404,headers});
  const identity=staffFromRequest(request);
  if(identity?.role!=="admin"||identity.email!=="president@campus2care.org")
    return NextResponse.json({ok:false,error:"founder_access_required"},{status:403,headers});
  try {
    requireProductionAudienceReview();
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
    return NextResponse.json({ok:true,campaigns:rows.map(r=>({
      runKey:r.run_key,state:r.state,approvedAt:r.approved_at.toISOString(),
      expiresAt:r.expires_at.toISOString(),expectedCount:r.expected_count,
      queued:r.queued,sent:r.sent,suppressed:r.suppressed,reconciliation:r.reconciliation,
      pending:r.pending
    }))},{headers});
  }catch{
    return NextResponse.json({ok:false,error:"campaign_status_unavailable"},
      {status:503,headers});
  }
}
