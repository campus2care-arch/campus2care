import { NextRequest } from "next/server";
import { interviewBaseOrigin } from "../../../../../lib/interview-auth";
import { interviewPrivateReply } from "../../../../../lib/interview-admin-api";
import { requestInterviewEmailVerification,verifyInterviewEmail } from "../../../../../lib/interview-invitations";
import { InterviewBookingError } from "../../../../../lib/interview-booking";
import {startSyntheticInterviewProcessing} from "../../../../../lib/interview-background";

export const maxDuration=60;
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request:NextRequest) {
  try {
    if(request.headers.get("origin")!==interviewBaseOrigin(request) || !request.headers.get("content-type")?.startsWith("application/json")) return interviewPrivateReply({ok:false,error:"invalid_request_origin"},403);
    const raw=await request.text(); if(raw.length>1000) return interviewPrivateReply({ok:false,error:"request_too_large"},413);
    const input=JSON.parse(raw);
    if(input.action==="request") await requestInterviewEmailVerification(input.invitationToken);
    else if(input.action==="verify") await verifyInterviewEmail(input.invitationToken,input.code);
    else return interviewPrivateReply({ok:false,error:"invalid_action"},400);
    startSyntheticInterviewProcessing();
    return interviewPrivateReply({ok:true});
  } catch(error) {
    if(error instanceof InterviewBookingError) return interviewPrivateReply({ok:false,error:error.code},error.status);
    return interviewPrivateReply({ok:false,error:"verification_unavailable"},503);
  }
}
