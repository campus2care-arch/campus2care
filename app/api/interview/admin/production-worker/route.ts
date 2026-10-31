import { NextRequest, NextResponse } from "next/server";
import { staffFromRequest, interviewBaseOrigin } from "../../../../../lib/interview-auth";
import { productionCanaryConfig } from "../../../../../lib/interview-production-canary";
import { processProductionCanaryOutbox } from "../../../../../lib/interview-production-worker";
import { productionRealEnabled } from "../../../../../lib/interview-production-launch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function response(status: number, error: string) {
  return NextResponse.json({ok:false,error}, {
    status,headers:{"Cache-Control":"no-store","Referrer-Policy":"no-referrer"},
  });
}
/** Administrator-triggered booking-job processing (canary or live mode); never queues outreach. */
export async function POST(request: NextRequest) {
  if(staffFromRequest(request)?.role!=="admin")return response(403,"admin_access_required");
  try {
    if(request.headers.get("origin")!==interviewBaseOrigin(request))return response(403,"invalid_request_origin");
    if (!productionRealEnabled()) productionCanaryConfig();
  } catch { return response(503,"production_canary_worker_disabled"); }
  try {
    const result=await processProductionCanaryOutbox(2);
    return NextResponse.json({ok:true,...result},{
      headers:{"Cache-Control":"no-store","Referrer-Policy":"no-referrer"},
    });
  } catch { return response(503,"production_canary_worker_unavailable"); }
}
