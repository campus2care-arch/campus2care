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
  getDbInterviewTemplate, saveDbInterviewTemplate,
} from "../../../../../lib/interview-week-db";
import { interviewStaffDatabase, productionStaffEnabled, rosterMember } from "../../../../../lib/interview-staff-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unavailable(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, {
    status, headers: { "Cache-Control": "no-store" },
  });
}

/** Whose availability this request reads or writes. Only an admin may act for
 * someone else, and in production that person must be on the current roster. */
async function subjectFor(req: NextRequest, requested: string | null | undefined) {
  const staff = staffFromRequest(req);
  if (!staff) return { error: unavailable("login_required", 401) };
  const target = (requested ?? "").trim().toLowerCase();
  const email = target && staff.role === "admin" ? target : staff.email;
  if (productionStaffEnabled()) {
    if (!(await rosterMember(email))) {
      return { error: unavailable(email === staff.email ? "not_on_interviewer_roster" : "interviewer_not_found", 403) };
    }
  } else {
    staffStoreToken();
    if (email !== staff.email) return { error: unavailable("acting_for_others_requires_production_roster", 400) };
  }
  return { staff, email, onBehalf: email !== staff.email };
}

export async function GET(req: NextRequest) {
  const week = req.nextUrl.searchParams.get("week") ?? "";
  try {
    const subject = await subjectFor(req, req.nextUrl.searchParams.get("as"));
    if ("error" in subject) return subject.error;
    if (!permittedWeek(week)) return unavailable("invalid_week", 400);
    const usingSql = isPostgresInterviewWeeksEnabled();
    const [template, confirmation] = await Promise.all([
      productionStaffEnabled() ? getDbInterviewTemplate(subject.email) : getTemplate(subject.email),
      usingSql ? getAuthoritativeInterviewWeek(subject.email, week) :
        getWeek(subject.email, week),
    ]);
    return NextResponse.json({
      ok: true, email: subject.email, role: subject.staff.role, onBehalf: subject.onBehalf,
      week, template: template.value, templateRevision: template.revision,
      approvalSource: "approvalSource" in confirmation ? confirmation.approvalSource : "ea",
      confirmation: confirmation.value, confirmationRevision: confirmation.revision,
      ...(usingSql ? { confirmationSource: "source" in confirmation ? confirmation.source : "postgres" } : {}),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return unavailable("interview_staff_unavailable", 503);
  }
}

export async function POST(req: NextRequest) {
  if (!staffFromRequest(req)) return unavailable("login_required", 401);
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
      status?: "confirmed" | "unavailable"; asEmail?: string;
    };
    const subject = await subjectFor(req, body.asEmail);
    if ("error" in subject) return subject.error;
    if (body.revision !== null && typeof body.revision !== "string") {
      return unavailable("missing_revision", 400);
    }
    if (!Array.isArray(body.recurringWindows)) return unavailable("invalid_windows", 400);
    if (body.action === "template") {
      const revision = productionStaffEnabled()
        ? await saveDbInterviewTemplate(subject.email, body.recurringWindows, body.revision)
        : await saveTemplate(subject.email, body.recurringWindows, body.revision);
      return NextResponse.json({ ok: true, revision }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "confirm" && body.weekStart &&
        permittedWeek(body.weekStart) &&
        (body.status === "confirmed" || body.status === "unavailable")) {
      const record: WeeklyConfirmation = {
        eaId: subject.email,
        weekStart: body.weekStart,
        status: body.status,
        confirmedAt: new Date().toISOString(),
        recurringWindows: body.recurringWindows,
        overrides: Array.isArray(body.overrides) ? body.overrides : [],
      };
      if (isPostgresInterviewWeeksEnabled()) {
        const saved = await saveAuthoritativeInterviewWeek(
          subject.email, body.weekStart, record, body.revision,
        );
        if (subject.onBehalf) {
          const sql = interviewStaffDatabase();
          await sql`INSERT INTO interview.audit_event
            (actor_ref, action, object_type, object_id, outcome, metadata)
            VALUES (${subject.staff.email}, 'founder_edit_availability', 'interviewer_week',
              ${subject.email + ":" + body.weekStart}, ${body.status}, ${sql.json({ revision: saved.revision })})`;
        }
        return NextResponse.json({
          ok: true, revision: saved.revision, confirmation: record,
          confirmationSource: "postgres",
          conflictedBookings: saved.conflictedBookings,
        }, { headers: { "Cache-Control": "no-store" } });
      }
      const revision = await saveWeek(subject.email, body.weekStart, record, body.revision);
      return NextResponse.json({
        ok: true, revision, confirmation: record,
      }, { headers: { "Cache-Control": "no-store" } });
    }
    return unavailable("invalid_action", 400);
  } catch (error) {
    if (error instanceof Error && error.message === "founder_managed_week") return unavailable("founder_managed_week", 409);
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
