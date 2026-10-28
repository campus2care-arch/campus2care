import { NextRequest, NextResponse } from "next/server";
import { staffFromRequest } from "../../../../../lib/interview-auth";
import { getWeek, permittedWeek, staffStoreToken } from "../../../../../lib/interview-store";
import { availabilityReadiness, type WeeklyConfirmation } from "../../../../../lib/interview-availability";

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
    const records = await Promise.all(eaEmails.map(async (email) =>
      (await getWeek(email, week)).value,
    ));
    const availability = availabilityReadiness(
      records.filter((r): r is WeeklyConfirmation => r !== null),
      eaEmails,
    ).map((item) => {
      const record = records[eaEmails.indexOf(item.eaId)];
      return {
        ...item, confirmedAt: record?.confirmedAt ?? null,
      };
    });
    return NextResponse.json({
      ok: true, week, availability,
      totalStaff: availability.length,
      confirmedCount: availability.filter((x) => x.status === "confirmed").length,
      respondedCount: availability.filter((x) => x.isResponded).length,
      potentialSlots: availability.reduce((a, x) => a + x.openSlotCount, 0),
      // This is capacity before confirmed bookings and Google Calendar busy checks.
      capacityType: "unadjusted",
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false, error: "readiness_unavailable" }, {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }
}
