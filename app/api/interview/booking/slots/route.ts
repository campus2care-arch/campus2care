import { NextRequest, NextResponse } from "next/server";
import { interviewBaseOrigin } from "../../../../../lib/interview-auth";
import { listStagingInterviewSlots } from "../../../../../lib/interview-slots";
import { InterviewBookingError } from "../../../../../lib/interview-booking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function reply(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, {
    status, headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(req: NextRequest) {
  if (process.env.VERCEL_ENV !== "preview" ||
      process.env.INTERVIEW_BOOKING_ENABLED !== "true") {
    return reply("interview_booking_disabled", 404);
  }
  try {
    if (req.headers.get("origin") !== interviewBaseOrigin(req) ||
        !req.headers.get("content-type")?.startsWith("application/json")) {
      return reply("invalid_request_origin", 403);
    }
    const raw = await req.text();
    if (raw.length > 2000) return reply("request_too_large", 413);
    const body = JSON.parse(raw) as { invitationToken?: string;reservationId?:string };
    const slots = await listStagingInterviewSlots(body?.invitationToken ?? "",body?.reservationId);
    return NextResponse.json({ ok: true, slots, timeZone: "America/New_York" }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof InterviewBookingError) return reply(error.code, error.status);
    if (error instanceof SyntaxError) return reply("invalid_request", 400);
    return reply("interview_slots_unavailable", 503);
  }
}
