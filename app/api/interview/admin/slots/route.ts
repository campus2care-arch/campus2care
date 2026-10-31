import { NextRequest } from "next/server";
import { interviewBaseOrigin, staffFromRequest } from "../../../../../lib/interview-auth";
import { interviewPrivateReply } from "../../../../../lib/interview-admin-api";
import { interviewStaffEnabled } from "../../../../../lib/interview-staff-db";
import { SlotError, generateSlotsFromAvailability, readSlotTimetable, removeOpenSlot } from "../../../../../lib/interview-founder-slots";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function guard(request: NextRequest) {
  if (!interviewStaffEnabled()) return interviewPrivateReply({ ok: false, error: "slots_disabled" }, 404);
  if (staffFromRequest(request)?.role !== "admin") return interviewPrivateReply({ ok: false, error: "admin_access_required" }, 403);
  if (request.method !== "GET" && (request.headers.get("origin") !== interviewBaseOrigin(request) ||
      !request.headers.get("content-type")?.startsWith("application/json"))) {
    return interviewPrivateReply({ ok: false, error: "invalid_request_origin" }, 403);
  }
  return null;
}

export async function GET(request: NextRequest) {
  const denied = guard(request); if (denied) return denied;
  const campus = request.nextUrl.searchParams.get("campus") ?? "ALL";
  const week = request.nextUrl.searchParams.get("week") ?? "";
  if (!["BU", "BC", "ALL"].includes(campus)) return interviewPrivateReply({ ok: false, error: "invalid_campus" }, 400);
  try {
    return interviewPrivateReply({ ok: true, slots: await readSlotTimetable(campus as "BU" | "BC" | "ALL", week) });
  } catch (error) {
    if (error instanceof SlotError) return interviewPrivateReply({ ok: false, error: error.code }, 400);
    return interviewPrivateReply({ ok: false, error: "slots_unavailable" }, 503);
  }
}

export async function POST(request: NextRequest) {
  const denied = guard(request); if (denied) return denied;
  const actor = staffFromRequest(request)!.email;
  try {
    const body = JSON.parse(await request.text()) as { action?: string; campus?: string; week?: string; slotId?: string };
    if (body.action === "generate" && (body.campus === "BU" || body.campus === "BC") && typeof body.week === "string") {
      return interviewPrivateReply({ ok: true, ...await generateSlotsFromAvailability(body.campus, body.week, actor) });
    }
    if (body.action === "remove" && typeof body.slotId === "string") {
      return interviewPrivateReply({ ok: true, ...await removeOpenSlot(body.slotId, actor) });
    }
    return interviewPrivateReply({ ok: false, error: "invalid_action" }, 400);
  } catch (error) {
    if (error instanceof SlotError) return interviewPrivateReply({ ok: false, error: error.code }, 400);
    if (error instanceof SyntaxError) return interviewPrivateReply({ ok: false, error: "invalid_request" }, 400);
    return interviewPrivateReply({ ok: false, error: "slot_update_unavailable" }, 503);
  }
}
