import { NextRequest, NextResponse } from "next/server";
import { interviewBaseOrigin, staffFromRequest } from "../../../../../lib/interview-auth";
import { productionCanaryConfig } from "../../../../../lib/interview-production-canary";
import {
  issueProductionCanaryInvitation, ProductionCanaryInvitationError,
} from "../../../../../lib/interview-production-canary-invitation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff" };
const error = (status: number, code: string) =>
  NextResponse.json({ ok: false, error: code }, { status, headers });

/** President-only test invitation. Does not send or preverify any invitation. */
export async function POST(request: NextRequest) {
  if (staffFromRequest(request)?.role !== "admin") {
    return error(403, "admin_access_required");
  }
  try { productionCanaryConfig(); }
  catch { return error(404, "production_canary_disabled"); }

  let origin: string;
  try { origin = interviewBaseOrigin(request); }
  catch { return error(403, "untrusted_origin"); }
  if (request.headers.get("origin") !== origin ||
      !request.headers.get("content-type")?.startsWith("application/json")) {
    return error(403, "invalid_request_origin");
  }

  try {
    const raw = await request.text();
    if (raw.length > 1000) return error(413, "request_too_large");
    const input = JSON.parse(raw) as Record<string, unknown>;
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        (input.campus !== "BU" && input.campus !== "BC") ||
        typeof input.email !== "string" ||
        typeof input.pageId !== "string") {
      return error(400, "invalid_canary_invitation");
    }
    const issued = await issueProductionCanaryInvitation({
      campus: input.campus, email: input.email, pageId: input.pageId,
    });
    return NextResponse.json({ ok: true, ...issued }, { status: 201, headers });
  } catch (cause) {
    if (cause instanceof SyntaxError) return error(400, "invalid_canary_invitation");
    if (cause instanceof ProductionCanaryInvitationError) {
      return error(cause.status, cause.code);
    }
    return error(503, "production_canary_invitation_unavailable");
  }
}
