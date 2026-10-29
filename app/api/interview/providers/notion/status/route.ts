import { NextRequest, NextResponse } from "next/server";
import { interviewBaseOrigin, staffFromRequest } from "../../../../../../lib/interview-auth";
import { providerAuthorizationEnabled } from "../../../../../../lib/interview-provider-store";
import { productionNotionStatus } from "../../../../../../lib/interview-production-notion-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  const json = (body: unknown, status = 200) => NextResponse.json(body, {
    status, headers: { "Cache-Control": "no-store" },
  });
  if (process.env.VERCEL_ENV !== "production" || !providerAuthorizationEnabled()) return json({ error: "production_setup_required" }, 404);
  if (staffFromRequest(req)?.role !== "admin") return json({ error: "admin_access_required" }, 403);
  try { interviewBaseOrigin(req); }
  catch { return json({ error: "untrusted_origin" }, 403); }
  return json({ checks: await productionNotionStatus(), checkedAt: new Date().toISOString() });
}
