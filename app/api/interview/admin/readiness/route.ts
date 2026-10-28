import { NextRequest, NextResponse } from "next/server";
import { staffFromRequest } from "../../../../../lib/interview-auth";
import { getWeek, permittedWeek, staffStoreToken } from "../../../../../lib/interview-store";
import { availabilityReadiness, type WeeklyConfirmation } from "../../../../../lib/interview-availability";
import {
  getAuthoritativeInterviewWeek, isPostgresInterviewWeeksEnabled,
  readInterviewRosterReadiness,
} from "../../../../../lib/interview-week-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const staff = staffFromRequest(req);
  if (!staff || staff.role !== "admin") {
    return NextResponse.json({ ok: false, error: "admin_access_required" }, {
      status: 403, headers: { "Cache-Control": "no-store" },
    });
  }
  const week = req.nextUrl.searchParams.get("week") ?? "";
  try {
    staffStoreToken();
    if (!permittedWeek(week)) return NextResponse.json({ ok: false, error: "invalid_week" }, { status: 400 });
    const eaEmails = [...new Set((process.env.INTERVIEW_EA_EMAILS ?? "")
      .split(",").map((email) => email.trim().toLowerCase()).filter((email) =>
        /^[a-z0-9._%+-]+@campus2care\.org$/.test(email),
      ))].slice(0, 100);
    const usingSql = isPostgresInterviewWeeksEnabled();
    const [snapshots, roster] = await Promise.all([
      Promise.all(eaEmails.map(async (email) =>
        usingSql ? getAuthoritativeInterviewWeek(email, week) :
          getWeek(email, week),
      )),
      usingSql ? readInterviewRosterReadiness() : Promise.resolve(new Map()),
    ]);
    const records = snapshots.map((snapshot) => snapshot.value);
    const availability = availabilityReadiness(
      records.filter((r): r is WeeklyConfirmation => r !== null),
      eaEmails,
    ).map((item) => {
      const index = eaEmails.indexOf(item.eaId);
      const record = records[index];
      const snapshot = snapshots[index];
      const source = "source" in snapshot ? snapshot.source : "legacy_blob";
      const member = roster.get(item.eaId);
      const enabled = !usingSql || (
        source === "postgres" && !!member?.active &&
        (member.weeklyCapacityLimit ?? 0) > 0
      );
      return {
        ...item, confirmedAt: record?.confirmedAt ?? null,
        confirmationSource: source,
        interviewerActive: usingSql ? !!member?.active : null,
        weeklyCapacityLimit: usingSql ? member?.weeklyCapacityLimit ?? 0 : null,
        bookableInDb: enabled,
      };
    });
    return NextResponse.json({
      ok: true, week, availability,
      totalStaff: availability.length,
      confirmedCount: availability.filter((x) => x.status === "confirmed").length,
      respondedCount: availability.filter((x) => x.isResponded).length,
      potentialSlots: availability.reduce((a, x) =>
        a + (x.bookableInDb
          ? Math.min(x.openSlotCount, x.weeklyCapacityLimit ?? x.openSlotCount)
          : 0), 0),
      // This is still capacity before booking conflicts and Calendar busy checks.
      capacityType: usingSql ? "confirmed_postgres_unadjusted" : "unadjusted",
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false, error: "readiness_unavailable" }, {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }
}
