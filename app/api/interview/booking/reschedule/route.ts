import { NextRequest, NextResponse } from "next/server";
import { interviewBaseOrigin } from "../../../../../lib/interview-auth";
import {InterviewBookingError,type HoldRequest} from "../../../../../lib/interview-booking";
import {requestStagingReschedule,abortStagingReschedule} from "../../../../../lib/interview-reschedule";

import {startSyntheticInterviewProcessing} from "../../../../../lib/interview-background";

export const maxDuration=60;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, {
    status, headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(req: NextRequest) {
  // This endpoint is deliberately for synthetic staging fixtures only.
  // No applicant flow can be enabled until Notion and Gmail identity checks exist.
  if (process.env.VERCEL_ENV !== "preview" ||
      process.env.INTERVIEW_BOOKING_ENABLED !== "true") {
    return json("interview_booking_disabled", 404);
  }
  try {
    if (req.headers.get("origin") !== interviewBaseOrigin(req) ||
        !req.headers.get("content-type")?.startsWith("application/json")) {
      return json("invalid_request_origin", 403);
    }
    const raw = await req.text();
    if (raw.length > 3000) return json("request_too_large", 413);
    const value = JSON.parse(raw) as HoldRequest & {reservationId:string;action?:string};
    if (!value || typeof value !== "object") return json("invalid_booking_request", 400);
    const held = value.action==="abort"?await abortStagingReschedule(value.invitationToken,value.reservationId):await requestStagingReschedule(value);
    startSyntheticInterviewProcessing();
    return NextResponse.json({ ok: true, reschedule: held }, {
      status: 201, headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof InterviewBookingError) return json(error.code, error.status);
    if (error instanceof SyntaxError) return json("invalid_booking_request", 400);
    return json("interview_booking_unavailable", 503);
  }
}
