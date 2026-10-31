import {NextRequest} from "next/server";
import {handleLiveInterviewRequest} from "../../../../../lib/interview-production-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
import {requestProductionRealVerification,completeProductionRealVerification,ProductionRealVerificationError}
    from "../../../../../lib/interview-production-real-verification";
export const maxDuration=60;
export async function POST(request:NextRequest){
 return handleLiveInterviewRequest(request,async input=>{
    const token=String(input.invitationToken??"");
    if(input.action==="request")return requestProductionRealVerification(token);
    if(input.action==="verify")return completeProductionRealVerification(token,String(input.code??""));
    throw new ProductionRealVerificationError("invalid_action",400);
 });
}