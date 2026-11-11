import { NextRequest } from "next/server";
import { staffFromRequest } from "../../../../../lib/interview-auth";
import { canUseSchedulingDashboard, scopedCampus } from "../../../../../lib/interview-access";
import { interviewPrivateReply } from "../../../../../lib/interview-admin-api";
import { loadFounderDashboard, summarize } from "../../../../../lib/interview-founder-dashboard";
import { ProductionAudienceReviewError } from "../../../../../lib/interview-production-applicant-review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Live dashboard: applicant names and emails go to the founder (any campus) and to a
 * chapter admin for their own campus only. Scope is enforced here, not in the browser.
 */
export async function GET(request: NextRequest) {
  if (process.env.VERCEL_ENV !== "production") return interviewPrivateReply({ ok: false, error: "production_only" }, 404);
  const staff = staffFromRequest(request);
  if (!canUseSchedulingDashboard(staff)) {
    return interviewPrivateReply({ ok: false, error: "founder_access_required" }, 403);
  }
  const requested = request.nextUrl.searchParams.get("campus");
  if (requested !== null && !["BU", "BC", "ALL"].includes(requested)) return interviewPrivateReply({ ok: false, error: "invalid_campus" }, 400);
  const campus = scopedCampus(staff, requested);
  if (!campus) return interviewPrivateReply({ ok: false, error: "chapter_scope_required" }, 403);
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
