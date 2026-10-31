import { NextRequest, NextResponse } from "next/server";
import { interviewBaseOrigin, staffFromRequest } from "../../../../../lib/interview-auth";
import {
  bookingProviderCanaryConfig, bookingProviderCanaryStatus,
  runBookingProviderCanary, cleanupBookingProviderCanary,
  BookingProviderCanaryError,
} from "../../../../../lib/interview-booking-provider-canary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "no-store, private", "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff" };
const fail = (status: number,code: string) =>
  NextResponse.json({ok:false,error:code},{status,headers});
function authenticate(request: NextRequest) {
  const staff = staffFromRequest(request);
  if(staff?.role!=="admin" || staff.email!=="president@campus2care.org") {
    throw new BookingProviderCanaryError("founder_access_required",403);
  }
  bookingProviderCanaryConfig();
}
export async function GET(request: NextRequest) {
  try {
    authenticate(request);
    return NextResponse.json({ok:true,result:await bookingProviderCanaryStatus()},{headers});
  }catch(e) {
    if(e instanceof BookingProviderCanaryError)return fail(e.status,e.code);
    return fail(503,"booking_provider_status_unavailable");
  }
}
/** Explicit-click operator action; never triggers from rendering or a cron. */
export async function POST(request: NextRequest) {
  try {
    authenticate(request);
    if(request.headers.get("origin")!==interviewBaseOrigin(request) ||
       !request.headers.get("content-type")?.startsWith("application/json")) {
      return fail(403,"invalid_request_origin");
    }
    const raw=await request.text();
    if(raw.length>80)return fail(413,"request_too_large");
    const input=JSON.parse(raw) as {action?:unknown};
    if(!input || typeof input!=="object" || Array.isArray(input) ||
      (input.action!=="create" && input.action!=="cleanup")) {
      return fail(400,"invalid_canary_action");
    }
    const result=input.action==="create" ? await runBookingProviderCanary() :
      await cleanupBookingProviderCanary();
    return NextResponse.json({ok:true,result},{headers});
  }catch(e){
    if(e instanceof SyntaxError)return fail(400,"invalid_canary_action");
    if(e instanceof BookingProviderCanaryError)return fail(e.status,e.code);
    return fail(503,"booking_provider_canary_unavailable");
  }
}
