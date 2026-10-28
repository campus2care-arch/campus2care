import { NextRequest } from "next/server";
import { interviewAdminGuard, interviewPrivateReply } from "../../../../../lib/interview-admin-api";
import { processInterviewOutboxBatch } from "../../../../../lib/interview-outbox";
import { handleInterviewOutboxJob, reconcileInterviewCalendarJob, recordVerifiedGmailAcceptance } from "../../../../../lib/interview-worker";
import { dispatchSyntheticInterviewMessages } from "../../../../../lib/interview-dispatch";
import {verifySyntheticNotionPipelines} from "../../../../../lib/interview-notion-verification";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function POST(request:NextRequest) {
  const denied = interviewAdminGuard(request); if (denied) return denied;
  try {
    const raw = await request.text(); if (raw.length > 1000) return interviewPrivateReply({ok:false,error:"request_too_large"},413);
    const input = JSON.parse(raw);
    if(input.action==="verify_notion")return interviewPrivateReply({ok:true,results:await verifySyntheticNotionPipelines()});
    if (input.action === "record_gmail_acceptance") {
      await recordVerifiedGmailAcceptance(input.jobId,input.gmailMessageId);
      return interviewPrivateReply({ok:true,claimed:0,completed:1});
    }
    if (input.action === "dispatch") return interviewPrivateReply({ok:true,...await dispatchSyntheticInterviewMessages()});
    if (input.action === "reconcile_calendar") await reconcileInterviewCalendarJob(input.jobId);
    else if (input.action !== "process") return interviewPrivateReply({ok:false,error:"invalid_action"},400);
    const result = await processInterviewOutboxBatch(handleInterviewOutboxJob, 2);
    return interviewPrivateReply({ok:true,...result});
  } catch { return interviewPrivateReply({ok:false,error:"worker_unavailable"},503); }
}
