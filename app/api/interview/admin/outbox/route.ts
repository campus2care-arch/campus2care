import { NextRequest, NextResponse } from "next/server";
import { staffFromRequest } from "../../../../../lib/interview-auth";
import { interviewOutboxReadiness } from "../../../../../lib/interview-outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Leadership-only status. Never returns tokens, applicant details, or payloads. */
export async function GET(request: NextRequest) {
  const staff = staffFromRequest(request);
  if (!staff || staff.role !== "admin") {
    return NextResponse.json({ ok:false, error:"admin_access_required" },
      { status:403, headers:{ "Cache-Control":"no-store" } });
  }
  if (process.env.VERCEL_ENV !== "preview") {
    return NextResponse.json({ ok:false, error:"staging_only" },
      { status:404, headers:{ "Cache-Control":"no-store" } });
  }
  try {
    const queues = await interviewOutboxReadiness();
    return NextResponse.json({ ok:true, queues, workerEnabled:false,
      note:"No provider handlers or scheduled dispatch have been activated." },
      { headers:{ "Cache-Control":"no-store" } });
  } catch {
    return NextResponse.json({ ok:false, error:"outbox_status_unavailable" },
      { status:503, headers:{ "Cache-Control":"no-store" } });
  }
}
