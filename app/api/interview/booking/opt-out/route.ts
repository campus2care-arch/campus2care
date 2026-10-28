import {NextRequest} from "next/server";
import {interviewBaseOrigin} from "../../../../../lib/interview-auth";
import {interviewPrivateReply} from "../../../../../lib/interview-admin-api";
import {optOutOfInterviewOutreach} from "../../../../../lib/interview-invitations";
import {InterviewBookingError} from "../../../../../lib/interview-booking";
export const runtime="nodejs";
export async function POST(request:NextRequest){
  try{
    if(request.headers.get('origin')!==interviewBaseOrigin(request)||!request.headers.get('content-type')?.startsWith('application/json'))return interviewPrivateReply({ok:false,error:'invalid_request_origin'},403);
    const raw=await request.text();if(raw.length>1000)return interviewPrivateReply({ok:false,error:'request_too_large'},413);
    await optOutOfInterviewOutreach(JSON.parse(raw).invitationToken);
    return interviewPrivateReply({ok:true});
  }catch(error){return interviewPrivateReply({ok:false,error:error instanceof InterviewBookingError?error.code:'opt_out_unavailable'},error instanceof InterviewBookingError?error.status:503);}
}
