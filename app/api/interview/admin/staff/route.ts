import { NextRequest } from "next/server";
import { interviewBaseOrigin, staffFromRequest } from "../../../../../lib/interview-auth";
import { interviewPrivateReply } from "../../../../../lib/interview-admin-api";
import { interviewStaffEnabled } from "../../../../../lib/interview-staff-db";
import { mondayForDate } from "../../../../../lib/interview-availability";
import {
  RosterError, markRosterInvited, parseRosterLines, readRosterWeek, removeFromRoster, upsertRoster, validateRosterInput,
} from "../../../../../lib/interview-staff-roster";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function guard(request: NextRequest) {
  if (!interviewStaffEnabled()) return interviewPrivateReply({ ok: false, error: "interviewer_roster_disabled" }, 404);
  const staff = staffFromRequest(request);
  if (staff?.role !== "admin") return interviewPrivateReply({ ok: false, error: "admin_access_required" }, 403);
  if (request.method !== "GET" && (request.headers.get("origin") !== interviewBaseOrigin(request) ||
      !request.headers.get("content-type")?.startsWith("application/json"))) {
    return interviewPrivateReply({ ok: false, error: "invalid_request_origin" }, 403);
  }
  return null;
}

/** Founder roster and weekly submission status, filtered by campus. */
export async function GET(request: NextRequest) {
  const denied = guard(request); if (denied) return denied;
  const week = request.nextUrl.searchParams.get("week") ?? "";
  const campus = request.nextUrl.searchParams.get("campus") ?? "ALL";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week) || mondayForDate(week) !== week || !["BU", "BC", "ALL"].includes(campus)) {
    return interviewPrivateReply({ ok: false, error: "invalid_request" }, 400);
  }
  try {
    return interviewPrivateReply({ ok: true, week, campus, roster: await readRosterWeek(week, campus as "BU" | "BC" | "ALL") });
  } catch {
    return interviewPrivateReply({ ok: false, error: "roster_unavailable" }, 503);
  }
}

export async function POST(request: NextRequest) {
  const denied = guard(request); if (denied) return denied;
  const actor = staffFromRequest(request)!.email;
  try {
    const raw = await request.text();
    if (raw.length > 20000) return interviewPrivateReply({ ok: false, error: "request_too_large" }, 413);
    const body = JSON.parse(raw) as { action?: string; campus?: string; lines?: string; person?: unknown;
      email?: string; emails?: string[] };
    if (body.action === "add") {
      if (body.campus !== "BU" && body.campus !== "BC") throw new RosterError("invalid_campus");
      return interviewPrivateReply({ ok: true, ...await upsertRoster(parseRosterLines(body.lines ?? "", body.campus), actor) });
    }
    if (body.action === "update") {
      return interviewPrivateReply({ ok: true, ...await upsertRoster([validateRosterInput(body.person)], actor) });
    }
    if (body.action === "remove" && typeof body.email === "string") {
      return interviewPrivateReply({ ok: true, ...await removeFromRoster(body.email, actor) });
    }
    if (body.action === "mark_invited" && Array.isArray(body.emails)) {
      return interviewPrivateReply({ ok: true, ...await markRosterInvited(body.emails.filter((e) => typeof e === "string")) });
    }
    return interviewPrivateReply({ ok: false, error: "invalid_action" }, 400);
  } catch (error) {
    if (error instanceof RosterError) return interviewPrivateReply({ ok: false, error: error.code }, 400);
    if (error instanceof SyntaxError) return interviewPrivateReply({ ok: false, error: "invalid_request" }, 400);
    return interviewPrivateReply({ ok: false, error: "roster_update_unavailable" }, 503);
  }
}
