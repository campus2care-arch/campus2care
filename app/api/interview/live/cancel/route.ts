import {NextRequest} from "next/server";
import {handleLiveInterviewRequest} from "../../../../../lib/interview-production-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
import {cancelProductionCanaryBooking} from "../../../../../lib/interview-production-cancellation";
export const maxDuration=60;
export async function POST(request:NextRequest){
 return handleLiveInterviewRequest(request,async input=>({
    booking:await cancelProductionCanaryBooking(String(input.invitationToken??""),
      String(input.reservationId??"")),
 }));
}