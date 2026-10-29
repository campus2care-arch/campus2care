import { NextRequest, NextResponse } from "next/server";
import { interviewBaseOrigin, staffFromRequest } from "../../../../../lib/interview-auth";
import { productionVerificationCanaryConfig } from "../../../../../lib/interview-production-verification-gate";
import { issueProductionCanaryInvitation, ProductionCanaryInvitationError } from "../../../../../lib/interview-production-canary-invitation";
import { requestProductionCanaryVerification, ProductionCanaryVerificationError } from "../../../../../lib/interview-production-canary-verification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const headers = {
  "Cache-Control": "no-store, private",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
const error = (status: number, code: string) =>
  NextResponse.json({ ok: false, error: code }, { status, headers });

/**
 * Explicit-click founder-only production email canary.
 * No bulk outreach, no staff invitations, no Calendar or Notion writes.
 * Exactly the two fixed and independently allowlisted test records.
 */
export async function POST(request: NextRequest) {
  if (staffFromRequest(request)?.role !== "admin") return error(403, "admin_access_required");
  try {
    if (!productionVerificationCanaryConfig().emailSendsApproved) {
      return error(403, "test_email_not_approved");
    }
    const origin = interviewBaseOrigin(request);
    if (request.headers.get("origin") !== origin ||
      !request.headers.get("content-type")?.startsWith("application/json")) {
      return error(403, "invalid_request_origin");
    }
  } catch { return error(403, "test_email_disabled"); }
  try {
    const raw = await request.text();
    if (raw.length > 128) return error(413, "request_too_large");
    const input = JSON.parse(raw) as { campus?: unknown };
    if (!input || typeof input !== "object" || Array.isArray(input) ||
      (input.campus !== "BU" && input.campus !== "BC")) {
      return error(400, "invalid_test_campus");
    }
    const campus = input.campus;
    const identity = campus === "BU"
      ? { campus: "BU" as const,
          email: "contact+interview-canary-bu@campus2care.org",
          pageId: "408d6c55a9de81da9063fe9a32d88d9b" }
      : { campus: "BC" as const,
          email: "contact+interview-canary-bc@campus2care.org",
          pageId: "408d6c55a9de8164b8faf8d438c8fa71" };
    const issued = await issueProductionCanaryInvitation(identity);
    const sent = await requestProductionCanaryVerification(issued.invitationToken);
    if (!sent.sent) return error(503, "test_email_delivery_uncertain");
    return NextResponse.json({
      ok: true, campus, invitationToken: issued.invitationToken,
      expiresAt: issued.expiresAt, emailVerificationRequired: true,
      recipient: identity.email,
    }, { status: 201, headers });
  } catch (cause) {
    if (cause instanceof SyntaxError) return error(400, "invalid_test_campus");
    if (cause instanceof ProductionCanaryInvitationError ||
        cause instanceof ProductionCanaryVerificationError) {
      return error(cause.status, cause.code);
    }
    return error(503, "test_email_unavailable");
  }
}
