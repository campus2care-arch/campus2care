import {NextRequest} from "next/server";
import {handleLiveInterviewRequest} from "../../../../../lib/interview-production-http";
import {processLiveBookingJobsSoon} from "../../../../../lib/interview-live-worker-kick";
export const runtime="nodejs";
export const dynamic="force-dynamic";
import {requestProductionCanaryReschedule} from "../../../../../lib/interview-production-booking";
export const maxDuration=60;
export async function POST(request:NextRequest){
 const response=await handleLiveInterviewRequest(request,async input=>({
    reschedule:await requestProductionCanaryReschedule({
      invitationToken:String(input.invitationToken??""),
      interviewerId:String(input.interviewerId??""),
      startsAt:String(input.startsAt??""),
      reservationId:String(input.reservationId??""),
    }),
 }));
 if(response.ok)processLiveBookingJobsSoon();
 return response;
}
