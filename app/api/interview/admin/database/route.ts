import { NextRequest, NextResponse } from "next/server";
import { staffFromRequest } from "../../../../../lib/interview-auth";
import { interviewSchemaHealth } from "../../../../../lib/interview-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const staff = staffFromRequest(req);
  if (!staff || staff.role !== "admin") {
    return NextResponse.json({ ok: false, error: "admin_access_required" }, {
      status: 403, headers: { "Cache-Control": "no-store" },
    });
  }
  // The database remains unavailable to production even if misconfigured.
  if (process.env.VERCEL_ENV !== "preview") {
    return NextResponse.json({ ok: false, error: "staging_only" }, {
      status: 404, headers: { "Cache-Control": "no-store" },
    });
  }
  try {
    const result = await interviewSchemaHealth();
    return NextResponse.json({ ok: true, ...result, environment: "preview" }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ ok: false, error: "interview_database_unavailable" }, {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }
}
