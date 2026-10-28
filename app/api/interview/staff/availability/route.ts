import { NextRequest, NextResponse } from "next/server";
import { interviewBaseOrigin, staffFromRequest } from "../../../../../lib/interview-auth";
import {
  getTemplate, getWeek, saveTemplate, saveWeek,
  permittedWeek, staffStoreToken,
} from "../../../../../lib/interview-store";
import type { WeeklyConfirmation, WeeklyWindows, DateOverride } from "../../../../../lib/interview-availability";
import {
  getAuthoritativeInterviewWeek, saveAuthoritativeInterviewWeek,
  isPostgresInterviewWeeksEnabled, InterviewWeekConflict,
} from "../../../../../lib/interview-week-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unavailable(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, {
    status, headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(req: NextRequest) {
  const staff = staffFromRequest(req);
  if (!staff) return unavailable("login_required", 401);
  const week = req.nextUrl.searchParams.get("week") ?? "";
  try {
    staffStoreToken();
    if (!permittedWeek(week)) return unavailable("invalid_week", 400);
    const usingSql = isPostgresInterviewWeeksEnabled();
    const [template, confirmation] = await Promise.all([
      getTemplate(staff.email),
      usingSql ? getAuthoritativeInterviewWeek(staff.email, week) :
        getWeek(staff.email, week),
    ]);
    return NextResponse.json({
      ok: true, email: staff.email, role: staff.role,
      week, template: template.value, templateRevision: template.revision,
      confirmation: confirmation.value, confirmationRevision: confirmation.revision,
      ...(usingSql ? { confirmationSource: "source" in confirmation ? confirmation.source : "postgres" } : {}),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return unavailable("interview_staff_unavailable", 503);
  }
}

export async function POST(req: NextRequest) {
  const staff = staffFromRequest(req);
  if (!staff) return unavailable("login_required", 401);
  try {
    const origin = interviewBaseOrigin(req);
    if (req.headers.get("origin") !== origin ||
        !req.headers.get("content-type")?.startsWith("application/json")) {
      return unavailable("invalid_request_origin", 403);
    }
    const raw = await req.text();
    if (raw.length > 20000) return unavailable("request_too_large", 413);
    const body = JSON.parse(raw) as {
      action?: string; weekStart?: string; revision?: string | null;
      recurringWindows?: WeeklyWindows[]; overrides?: DateOverride[];
      status?: "confirmed" | "unavailable";
    };
    staffStoreToken();
    if (body.revision !== null && typeof body.revision !== "string") {
      return unavailable("missing_revision", 400);
    }
    if (!Array.isArray(body.recurringWindows)) return unavailable("invalid_windows", 400);
    if (body.action === "template") {
      const revision = await saveTemplate(staff.email, body.recurringWindows, body.revision);
      return NextResponse.json({ ok: true, revision }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "confirm" && body.weekStart &&
        permittedWeek(body.weekStart) &&
        (body.status === "confirmed" || body.status === "unavailable")) {
      const record: WeeklyConfirmation = {
        eaId: staff.email,
        weekStart: body.weekStart,
        status: body.status,
        confirmedAt: new Date().toISOString(),
        recurringWindows: body.recurringWindows,
        overrides: Array.isArray(body.overrides) ? body.overrides : [],
      };
      if (isPostgresInterviewWeeksEnabled()) {
        const saved = await saveAuthoritativeInterviewWeek(
          staff.email, body.weekStart, record, body.revision,
        );
        return NextResponse.json({
          ok: true, revision: saved.revision, confirmation: record,
          confirmationSource: "postgres",
          conflictedBookings: saved.conflictedBookings,
        }, { headers: { "Cache-Control": "no-store" } });
      }
      const revision = await saveWeek(staff.email, body.weekStart, record, body.revision);
      return NextResponse.json({
        ok: true, revision, confirmation: record,
      }, { headers: { "Cache-Control": "no-store" } });
    }
    return unavailable("invalid_action", 400);
  } catch (error) {
    if (error instanceof InterviewWeekConflict) {
      return unavailable("availability_modified_elsewhere", 409);
    }
    if (error instanceof SyntaxError || error instanceof TypeError ||
        (error instanceof Error && /^(invalid_|missing_|duplicate_|overlapping_|override_)/.test(error.message))) {
      return unavailable("invalid_availability", 400);
    }
    if (error instanceof Error && /Precondition|already exists|exists|conflict/i.test(error.message)) {
      return unavailable("availability_modified_elsewhere", 409);
    }
    return unavailable("availability_save_unavailable", 503);
  }
}
