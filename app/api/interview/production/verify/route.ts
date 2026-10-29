import { NextRequest, NextResponse } from "next/server";
import { interviewBaseOrigin } from "../../../../../lib/interview-auth";
import { productionCanaryConfig } from "../../../../../lib/interview-production-canary";
import {
  requestProductionCanaryVerification, completeProductionCanaryVerification,
  ProductionCanaryVerificationError,
} from "../../../../../lib/interview-production-canary-verification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff" };
const error = (status: number, code: string) =>
  NextResponse.json({ ok: false, error: code }, { status, headers });

/**
 * Canary-only email verification, using an expiring invitation secret.
 * Never permits public application enrollment or broader outreach.
 */
export async function POST(request: NextRequest) {
  try { productionCanaryConfig(); }
  catch { return error(404, "production_canary_disabled"); }
  try {
    if (request.headers.get("origin") !== interviewBaseOrigin(request) ||
        !request.headers.get("content-type")?.startsWith("application/json")) {
      return error(403, "invalid_request_origin");
    }
  } catch { return error(403, "untrusted_origin"); }

  try {
    const raw = await request.text();
    if (raw.length > 1000) return error(413, "request_too_large");
    const input = JSON.parse(raw) as Record<string, unknown>;
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        typeof input.invitationToken !== "string") {
      return error(400, "invalid_verification_request");
    }
    if (input.action === "request") {
      const result = await requestProductionCanaryVerification(input.invitationToken);
      return NextResponse.json({ ok: true, ...result }, { headers });
    }
    if (input.action === "verify" && typeof input.code === "string") {
      const result = await completeProductionCanaryVerification(input.invitationToken, input.code);
      return NextResponse.json({ ok: true, ...result }, { headers });
    }
    return error(400, "invalid_verification_request");
  } catch (cause) {
    if (cause instanceof SyntaxError) return error(400, "invalid_verification_request");
    if (cause instanceof ProductionCanaryVerificationError) {
      return error(cause.status, cause.code);
    }
    return error(503, "production_verification_unavailable");
  }
}
