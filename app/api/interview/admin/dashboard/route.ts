import { NextRequest } from "next/server";
import { staffFromRequest } from "../../../../../lib/interview-auth";
import { interviewPrivateReply } from "../../../../../lib/interview-admin-api";
import { loadFounderDashboard, summarize } from "../../../../../lib/interview-founder-dashboard";
import { ProductionAudienceReviewError } from "../../../../../lib/interview-production-applicant-review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Founder-only live dashboard: applicant names and emails are shown to the founder alone. */
export async function GET(request: NextRequest) {
  if (process.env.VERCEL_ENV !== "production") return interviewPrivateReply({ ok: false, error: "production_only" }, 404);
  const staff = staffFromRequest(request);
  if (staff?.role !== "admin" || staff.email !== "president@campus2care.org") {
    return interviewPrivateReply({ ok: false, error: "founder_access_required" }, 403);
  }
  const campus = request.nextUrl.searchParams.get("campus") ?? "ALL";
  if (!["BU", "BC", "ALL"].includes(campus)) return interviewPrivateReply({ ok: false, error: "invalid_campus" }, 400);
  try {
    const data = await loadFounderDashboard();
    const scope = campus as "BU" | "BC" | "ALL";
    const inScope = <T extends { campus: string }>(list: T[]) => list.filter((x) => scope === "ALL" || x.campus === scope);
    return interviewPrivateReply({ ok: true, campus,
      summary: summarize(data.rows, scope, data.openSlots, data.remainingCapacity),
      remainingCapacity: data.remainingCapacity, applicants: inScope(data.rows), mismatches: inScope(data.mismatches) });
  } catch (error) {
    const code = error instanceof ProductionAudienceReviewError ? error.code : "dashboard_unavailable";
    return interviewPrivateReply({ ok: false, error: code }, code === "audience_review_disabled" ? 409 : 503);
  }
}
