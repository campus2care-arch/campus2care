import { NextRequest, NextResponse } from "next/server";
import { interviewBaseOrigin } from "../../../../../lib/interview-auth";
import { productionCanaryConfig } from "../../../../../lib/interview-production-canary";
import { cancelProductionCanaryBooking } from "../../../../../lib/interview-production-cancellation";
import { ProductionBookingError } from "../../../../../lib/interview-production-booking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: NextRequest) {
  const reply = (body: unknown, status: number) => NextResponse.json(body, {
    status, headers: {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"},
  });
  try { productionCanaryConfig(); }
  catch { return reply({error: "interview_production_canary_not_available"}, 404); }
  try {
    if (req.headers.get("origin") !== interviewBaseOrigin(req) ||
        !req.headers.get("content-type")?.startsWith("application/json")) return reply({error: "invalid_request_origin"}, 403);
    const raw = await req.text();
    if (raw.length > 3000) return reply({error: "request_too_large"}, 413);
    const input = JSON.parse(raw);
    if (!input || typeof input !== "object") return reply({error: "invalid_cancellation_request"}, 400);
    return reply({ok: true, booking: await cancelProductionCanaryBooking(input.invitationToken, input.reservationId)}, 200);
  } catch (error) {
    if (error instanceof SyntaxError) return reply({error: "invalid_cancellation_request"}, 400);
    if (error instanceof ProductionBookingError) return reply({error: error.code}, error.status);
    return reply({error: "interview_production_cancellation_unavailable"}, 503);
  }
}
