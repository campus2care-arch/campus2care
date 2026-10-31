import {NextRequest} from "next/server";
import {handleLiveInterviewRequest} from "../../../../../lib/interview-production-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
import {readLiveInterviewSlots} from "../../../../../lib/interview-production-public";
export async function POST(request:NextRequest){
 return handleLiveInterviewRequest(request,async input=>({
    slots:await readLiveInterviewSlots(String(input.invitationToken??""),
      typeof input.reservationId==="string"?input.reservationId:undefined),
    timeZone:"America/New_York",
 }));
}