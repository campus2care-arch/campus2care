import {NextRequest} from "next/server";
import {handleLiveInterviewRequest} from "../../../../../lib/interview-production-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
import {optOutLiveInterview} from "../../../../../lib/interview-production-public";
export async function POST(request:NextRequest){
 return handleLiveInterviewRequest(request,async input=>(
    await optOutLiveInterview(String(input.invitationToken??""))
 ));
}