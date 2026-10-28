import { NextRequest, NextResponse } from "next/server";
import { interviewBaseOrigin } from "../../../../../lib/interview-auth";
import { cancelStagingInterviewHold } from "../../../../../lib/interview-cancellation";
import { InterviewBookingError } from "../../../../../lib/interview-booking";

import {startSyntheticInterviewProcessing} from "../../../../../lib/interview-background";

export const maxDuration=60;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, {
    status, headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(req: NextRequest) {
  if (process.env.VERCEL_ENV !== "preview" ||
      process.env.INTERVIEW_BOOKING_ENABLED !== "true") {
    return failure("interview_booking_disabled", 404);
  }
  try {
    if (req.headers.get("origin") !== interviewBaseOrigin(req) ||
        !req.headers.get("content-type")?.startsWith("application/json")) {
      return failure("invalid_request_origin", 403);
    }
    const raw = await req.text();
    if (raw.length > 2000) return failure("request_too_large", 413);
    const body = JSON.parse(raw) as { invitationToken?: string; reservationId?: string };
    const result = await cancelStagingInterviewHold(
      body?.invitationToken ?? "", body?.reservationId ?? "",
    );
    startSyntheticInterviewProcessing();
    return NextResponse.json({ ok: true, cancellation: result }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof InterviewBookingError) return failure(error.code, error.status);
    if (error instanceof SyntaxError) return failure("invalid_cancellation_request", 400);
    return failure("interview_cancellation_unavailable", 503);
  }
}
