import {NextRequest} from "next/server";
import {handleLiveInterviewRequest} from "../../../../../lib/interview-production-http";
import {processLiveBookingJobsSoon} from "../../../../../lib/interview-live-worker-kick";
export const runtime="nodejs";
export const dynamic="force-dynamic";
import {cancelProductionCanaryBooking} from "../../../../../lib/interview-production-cancellation";
export const maxDuration=60;
export async function POST(request:NextRequest){
 const response=await handleLiveInterviewRequest(request,async input=>({
    booking:await cancelProductionCanaryBooking(String(input.invitationToken??""),
      String(input.reservationId??"")),
 }));
 if(response.ok)processLiveBookingJobsSoon();
 return response;
}
