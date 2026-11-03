import {NextRequest} from "next/server";
import {handleLiveInterviewRequest} from "../../../../../lib/interview-production-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
import {optOutLiveInterview,resumeLiveInterviewInvites} from "../../../../../lib/interview-production-public";
export async function POST(request:NextRequest){
 return handleLiveInterviewRequest(request,async input=>(
    input.action==="resume"
      ? await resumeLiveInterviewInvites(String(input.invitationToken??""))
      : await optOutLiveInterview(String(input.invitationToken??""))
 ));
}