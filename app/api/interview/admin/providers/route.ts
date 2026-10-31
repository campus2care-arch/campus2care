import { NextRequest, NextResponse } from "next/server";
import { interviewBaseOrigin, staffFromRequest } from "../../../../../lib/interview-auth";
import { providerVerificationStatus, runSyntheticCalendarVerification } from "../../../../../lib/interview-provider-verification";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
function allowed(req: NextRequest) {
  return process.env.VERCEL_ENV === "preview" && staffFromRequest(req)?.role === "admin";
}
export async function GET(req: NextRequest) {
  if (!allowed(req)) return json({ ok: false, error: "admin_preview_required" }, 403);
  try { return json({ ok: true, ...await providerVerificationStatus() }); }
  catch { return json({ ok: false, error: "provider_status_unavailable" }, 503); }
}
export async function POST(req: NextRequest) {
  if (!allowed(req)) return json({ ok: false, error: "admin_preview_required" }, 403);
  try {
    if (req.headers.get("origin") !== interviewBaseOrigin(req) || !req.headers.get("content-type")?.startsWith("application/json")) return json({ ok: false, error: "invalid_request_origin" }, 403);
    const raw = await req.text();
    if (raw.length > 2000) return json({ ok: false, error: "request_too_large" }, 413);
    const body = JSON.parse(raw) as { runId?: string; action?: string };
    if (!["verify_calendar", "cleanup_calendar"].includes(body.action ?? "")) return json({ ok: false, error: "invalid_verification_action" }, 400);
    return json({ ok: true, test: await runSyntheticCalendarVerification(body.runId ?? "", body.action === "cleanup_calendar") });
  } catch { return json({ ok: false, error: "synthetic_verification_unavailable", message: "Check connections and use Reconcile test if a prior run needs cleanup." }, 503); }
}
