import { NextRequest } from "next/server";
import { interviewBaseOrigin, staffFromRequest } from "../../../../../lib/interview-auth";
import { interviewPrivateReply } from "../../../../../lib/interview-admin-api";
import { chapterContext, chapterOf, isFounder, type ChapterContext } from "../../../../../lib/interview-access";
import type { StaffIdentity } from "../../../../../lib/interview-auth";
import { interviewStaffEnabled, rosterMember } from "../../../../../lib/interview-staff-db";
import { mondayForDate } from "../../../../../lib/interview-availability";
import {
  RosterError, markRosterInvited, parseRosterLines, readRosterWeek, removeFromRoster, upsertRoster, validateRosterInput,
} from "../../../../../lib/interview-staff-roster";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Allowed = { staff: StaffIdentity; chapter: ChapterContext | null };

async function guard(request: NextRequest): Promise<{ denied: Response } | Allowed> {
  if (!interviewStaffEnabled()) return { denied: interviewPrivateReply({ ok: false, error: "interviewer_roster_disabled" }, 404) };
  const staff = staffFromRequest(request);
  if (!staff || (!isFounder(staff) && !chapterOf(staff))) return { denied: interviewPrivateReply({ ok: false, error: "admin_access_required" }, 403) };
  if (request.method !== "GET" && (request.headers.get("origin") !== interviewBaseOrigin(request) ||
      !request.headers.get("content-type")?.startsWith("application/json"))) {
    return { denied: interviewPrivateReply({ ok: false, error: "invalid_request_origin" }, 403) };
  }
  if (!chapterOf(staff)) return { staff, chapter: null };
  const chapter = await chapterContext(staff, rosterMember);
  if (!chapter) return { denied: interviewPrivateReply({ ok: false, error: "chapter_admin_not_on_roster" }, 403) };
  return { staff, chapter };
}

/** Founder roster and weekly submission status, filtered by campus. */
export async function GET(request: NextRequest) {
  const allowed = await guard(request); if ("denied" in allowed) return allowed.denied;
  const week = request.nextUrl.searchParams.get("week") ?? "";
  const chapter = allowed.chapter?.campus ?? null;
  const requested = request.nextUrl.searchParams.get("campus") ?? (chapter ?? "ALL");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week) || mondayForDate(week) !== week || !["BU", "BC", "ALL"].includes(requested)) {
    return interviewPrivateReply({ ok: false, error: "invalid_request" }, 400);
  }
  // Admins keep their existing all-campus roster view; chapter admins see their own campus only.
  const campus = chapter ? (requested === chapter ? chapter : null) : requested;
  if (!campus) return interviewPrivateReply({ ok: false, error: "chapter_scope_required" }, 403);
  try {
    return interviewPrivateReply({ ok: true, week, campus, roster: await readRosterWeek(week, campus as "BU" | "BC" | "ALL") });
  } catch {
    return interviewPrivateReply({ ok: false, error: "roster_unavailable" }, 503);
  }
}

export async function POST(request: NextRequest) {
  const allowed = await guard(request); if ("denied" in allowed) return allowed.denied;
  const actor = allowed.staff.email;
  // Chapter admins manage only their own team; enforced again inside each transaction.
  const chapter = allowed.chapter ?? undefined;
  try {
    const raw = await request.text();
    if (raw.length > 20000) return interviewPrivateReply({ ok: false, error: "request_too_large" }, 413);
    const body = JSON.parse(raw) as { action?: string; campus?: string; lines?: string; person?: unknown;
      email?: string; emails?: string[] };
    if (body.action === "add") {
      if (body.campus !== "BU" && body.campus !== "BC") throw new RosterError("invalid_campus");
      if (chapter && body.campus !== chapter.campus) throw new RosterError("outside_chapter_scope");
      return interviewPrivateReply({ ok: true, ...await upsertRoster(parseRosterLines(body.lines ?? "", body.campus), actor, undefined, chapter) });
    }
    if (body.action === "update") {
      return interviewPrivateReply({ ok: true, ...await upsertRoster([validateRosterInput(body.person)], actor, undefined, chapter) });
    }
    if (body.action === "remove" && typeof body.email === "string") {
      return interviewPrivateReply({ ok: true, ...await removeFromRoster(body.email, actor, undefined, chapter) });
    }
    if (body.action === "mark_invited" && Array.isArray(body.emails)) {
      return interviewPrivateReply({ ok: true, ...await markRosterInvited(body.emails.filter((e) => typeof e === "string"), undefined, chapter) });
    }
    return interviewPrivateReply({ ok: false, error: "invalid_action" }, 400);
  } catch (error) {
    if (error instanceof RosterError) return interviewPrivateReply({ ok: false, error: error.code }, 400);
    if (error instanceof SyntaxError) return interviewPrivateReply({ ok: false, error: "invalid_request" }, 400);
    return interviewPrivateReply({ ok: false, error: "roster_update_unavailable" }, 503);
  }
}
