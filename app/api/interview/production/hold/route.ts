import { NextRequest, NextResponse } from "next/server";
import { interviewBaseOrigin } from "../../../../../lib/interview-auth";
import { productionCanaryConfig } from "../../../../../lib/interview-production-canary";
import { createProductionCanaryHold, ProductionBookingError } from "../../../../../lib/interview-production-booking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function reply(status: number,error: string) {
  return NextResponse.json({ok:false,error}, {
    status, headers:{"Cache-Control":"no-store","Referrer-Policy":"no-referrer"},
  });
}

/**
 * Canary-only production transaction endpoint, not the public booking flow.
 * Unconfigured integrations, real-recipient campaigns and unknown identities
 * are rejected. Appointments are not confirmed until async providers succeed.
 */
export async function POST(request: NextRequest) {
  try { productionCanaryConfig(); }
  catch { return reply(404,"interview_production_canary_not_available"); }
  try {
    if (request.headers.get("origin") !== interviewBaseOrigin(request) ||
        !request.headers.get("content-type")?.startsWith("application/json")) {
      return reply(403,"invalid_request_origin");
    }
    const raw = await request.text();
    if(raw.length>3000)return reply(413,"request_too_large");
    const input = JSON.parse(raw);
    if (!input || typeof input !== "object") return reply(400,"invalid_booking_request");
    const booked = await createProductionCanaryHold(input);
    return NextResponse.json({ok:true,booking:booked},{
      status:201,headers:{"Cache-Control":"no-store","Referrer-Policy":"no-referrer"},
    });
  } catch(error) {
    if(error instanceof SyntaxError)return reply(400,"invalid_booking_request");
    if(error instanceof ProductionBookingError)return reply(error.status,error.code);
    // Do not reveal applicant or provider account details to the public client.
    return reply(503,"interview_production_booking_unavailable");
  }
}
