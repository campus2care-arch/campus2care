import {NextRequest} from "next/server";
import {handleLiveInterviewRequest} from "../../../../../lib/interview-production-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
import {createProductionCanaryHold} from "../../../../../lib/interview-production-booking";
export const maxDuration=60;
export async function POST(request:NextRequest){
 return handleLiveInterviewRequest(request,async input=>({
    booking:await createProductionCanaryHold({
      invitationToken:String(input.invitationToken??""),
      interviewerId:String(input.interviewerId??""),
      startsAt:String(input.startsAt??""),
    }),
 }));
}