import { NextRequest, NextResponse } from "next/server";
import { staffFromRequest } from "../../../../../lib/interview-auth";
import { readProductionInterviewPreflight } from "../../../../../lib/interview-production-preflight";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** No booking or invitation writes. Intended for founder verification only. */
export async function GET(request: NextRequest) {
  if (process.env.VERCEL_ENV !== "production") {
    return NextResponse.json({ok:false,error:"not_found"}, {status:404});
  }
  if (staffFromRequest(request)?.role !== "admin") {
    return NextResponse.json({ok:false,error:"admin_access_required"}, {status:403});
  }
  try {
    const snapshot = await readProductionInterviewPreflight();
    return NextResponse.json({ok:true,...snapshot},{
      headers:{"Cache-Control":"no-store","Referrer-Policy":"no-referrer"},
    });
  } catch {
    return NextResponse.json({ok:false,error:"production_preflight_unavailable"},{
      status:503,headers:{"Cache-Control":"no-store"},
    });
  }
}
