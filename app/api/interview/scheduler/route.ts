import {NextRequest} from "next/server";
import {interviewSchedulerAuthorized} from "../../../../lib/interview-scheduler-auth";
import {interviewPrivateReply} from "../../../../lib/interview-admin-api";
import {dispatchSyntheticInterviewMessages} from "../../../../lib/interview-dispatch";
import {processInterviewOutboxBatch,interviewOutboxReadiness} from "../../../../lib/interview-outbox";
import {handleInterviewOutboxJob} from "../../../../lib/interview-worker";
import {interviewDatabase} from "../../../../lib/interview-db";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
export async function POST(request:NextRequest){
  if(!interviewSchedulerAuthorized(request.headers.get("authorization")))return interviewPrivateReply({ok:false,error:"scheduler_unauthorized"},403);
  try{
    const dispatch=await dispatchSyntheticInterviewMessages();
    const worker=await processInterviewOutboxBatch(handleInterviewOutboxJob,2);
    const queues=await interviewOutboxReadiness();
    const healthy=queues.failed===0&&queues.reconciliation===0;
    await interviewDatabase()`INSERT INTO interview.audit_event(actor_ref,action,object_type,object_id,outcome,metadata)
      VALUES('scheduler','heartbeat','runtime','staging',${healthy?"healthy":"needs_attention"},'{}'::jsonb)`;
    return interviewPrivateReply({ok:healthy,dispatch,worker,queues},healthy?200:503);
  }catch{return interviewPrivateReply({ok:false,error:"scheduler_failed"},503);}
}
