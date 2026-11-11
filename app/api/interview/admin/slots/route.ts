import { NextRequest } from "next/server";
import { interviewBaseOrigin, staffFromRequest } from "../../../../../lib/interview-auth";
import { interviewPrivateReply } from "../../../../../lib/interview-admin-api";
import { canUseSchedulingDashboard, chapterContext, chapterOf, scopedCampus, type ChapterContext } from "../../../../../lib/interview-access";
import type { StaffIdentity } from "../../../../../lib/interview-auth";
import { interviewStaffEnabled, rosterMember } from "../../../../../lib/interview-staff-db";
import { SlotError, generateSlotsFromAvailability, readSlotTimetable, removeOpenSlot, recordReservationAttendance } from "../../../../../lib/interview-founder-slots";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Allowed = { staff: StaffIdentity; chapter: ChapterContext | null };

async function guard(request: NextRequest): Promise<{ denied: Response } | Allowed> {
  if (!interviewStaffEnabled()) return { denied: interviewPrivateReply({ ok: false, error: "slots_disabled" }, 404) };
  const staff = staffFromRequest(request);
  // Chapter admins read their own campus and record attendance for their own team. Slot generation
  // and removal stay founder-only: the booking transaction accepts founder-approved slots only.
  // Browser filtering is not an authorization boundary; every action is re-checked below.
  if (!staff || !canUseSchedulingDashboard(staff))
    return { denied: interviewPrivateReply({ ok: false, error: "founder_access_required" }, 403) };
  if (request.method !== "GET" && (request.headers.get("origin") !== interviewBaseOrigin(request) ||
      !request.headers.get("content-type")?.startsWith("application/json"))) {
    return { denied: interviewPrivateReply({ ok: false, error: "invalid_request_origin" }, 403) };
  }
  if (!chapterOf(staff)) return { staff, chapter: null };
  const chapter = await chapterContext(staff, rosterMember);
  if (!chapter) return { denied: interviewPrivateReply({ ok: false, error: "chapter_admin_not_on_roster" }, 403) };
  return { staff, chapter };
}

export async function GET(request: NextRequest) {
  const allowed = await guard(request); if ("denied" in allowed) return allowed.denied;
  const requested = request.nextUrl.searchParams.get("campus");
  const week = request.nextUrl.searchParams.get("week") ?? "";
  if (requested !== null && !["BU", "BC", "ALL"].includes(requested)) return interviewPrivateReply({ ok: false, error: "invalid_campus" }, 400);
  const campus = scopedCampus(allowed.staff, requested);
  if (!campus) return interviewPrivateReply({ ok: false, error: "chapter_scope_required" }, 403);
  try {
    return interviewPrivateReply({ ok: true, slots: await readSlotTimetable(campus as "BU" | "BC" | "ALL", week) });
  } catch (error) {
    if (error instanceof SlotError) return interviewPrivateReply({ ok: false, error: error.code }, 400);
    return interviewPrivateReply({ ok: false, error: "slots_unavailable" }, 503);
  }
}

export async function POST(request: NextRequest) {
  const allowed = await guard(request); if ("denied" in allowed) return allowed.denied;
  const actor = allowed.staff.email;
  const chapter = allowed.chapter;
  try {
    const body = JSON.parse(await request.text()) as { action?: string; campus?: string; week?: string; slotId?: string;
      reservationId?: string; outcome?: string };
    if (chapter) {
      if (body.action !== "attendance") return interviewPrivateReply({ ok: false, error: "founder_access_required" }, 403);
      if (typeof body.reservationId === "string" &&
        (body.outcome === "completed" || body.outcome === "no_show" || body.outcome === "not_recorded")) {
        return interviewPrivateReply({ ok: true,
          ...await recordReservationAttendance(body.reservationId, body.outcome, actor, undefined, chapter) });
      }
      return interviewPrivateReply({ ok: false, error: "invalid_action" }, 400);
    }
    if (body.action === "generate" && (body.campus === "BU" || body.campus === "BC") && typeof body.week === "string") {
      return interviewPrivateReply({ ok: true, ...await generateSlotsFromAvailability(body.campus, body.week, actor) });
    }
    if (body.action === "remove" && typeof body.slotId === "string") {
      return interviewPrivateReply({ ok: true, ...await removeOpenSlot(body.slotId, actor) });
    }
    if (body.action === "attendance" && typeof body.reservationId === "string" &&
      (body.outcome === "completed" || body.outcome === "no_show" || body.outcome === "not_recorded")) {
      return interviewPrivateReply({ ok: true, ...await recordReservationAttendance(body.reservationId, body.outcome, actor) });
    }
    return interviewPrivateReply({ ok: false, error: "invalid_action" }, 400);
  } catch (error) {
    if (error instanceof SlotError) return interviewPrivateReply({ ok: false, error: error.code }, 400);
    if (error instanceof SyntaxError) return interviewPrivateReply({ ok: false, error: "invalid_request" }, 400);
    return interviewPrivateReply({ ok: false, error: "slot_update_unavailable" }, 503);
  }
}
