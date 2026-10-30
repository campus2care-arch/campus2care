import {NextRequest,NextResponse} from "next/server";
import {staffFromRequest} from "../../../../../lib/interview-auth";
import {
  scanProductionApplicantPipelines,reviewProductionApplicantAudience,
  ProductionAudienceReviewError,
} from "../../../../../lib/interview-production-applicant-review";
import {loadProductionAudienceFacts} from "../../../../../lib/interview-production-audience-facts";
import {productionInterviewDatabase} from "../../../../../lib/interview-production-db";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
const headers={"Cache-Control":"no-store, private","Referrer-Policy":"no-referrer",
  "X-Content-Type-Options":"nosniff"};

/** Founder-only, disabled by default, strictly read-only audience preflight. */
export async function GET(request:NextRequest) {
  if(process.env.VERCEL_ENV!=="production")
    return NextResponse.json({ok:false,error:"not_found"},{status:404,headers});
  const staff=staffFromRequest(request);
  if(staff?.role!=="admin"||staff.email!=="president@campus2care.org")
    return NextResponse.json({ok:false,error:"founder_access_required"},{status:403,headers});
  try {
    const applicants=await scanProductionApplicantPipelines();
    const facts=await loadProductionAudienceFacts(productionInterviewDatabase());
    const review=reviewProductionApplicantAudience({applicants,facts,
      authSecret:process.env.INTERVIEW_AUTH_SECRET??"",now:new Date()});
    // Deliberately NO applicant email, name, page ID or HMAC in HTTP response.
    // The manifest fingerprint is informational, never authorization to send.
    return NextResponse.json({ok:true,mode:"read_only",canSend:false,
      scanned:review.scanned,countsByDecision:review.countsByDecision,
      readyForFounderReview:review.readyForFounderReview,
      manifestSha256:review.manifestSha256,
      manualOutreachReconciled:false,
      note:"No applicant enrollment, token issuance, database mutation, or email send occurred."},
      {headers});
  } catch(error) {
    const code=error instanceof ProductionAudienceReviewError?error.code:"audience_review_unavailable";
    return NextResponse.json({ok:false,error:code},{status:503,headers});
  }
}
