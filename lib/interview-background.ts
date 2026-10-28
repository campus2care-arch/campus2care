import { after } from "next/server";
import { isInterviewWorkerEnabled,processInterviewOutboxBatch } from "./interview-outbox";
import { handleInterviewOutboxJob } from "./interview-worker";
/** Durable jobs commit first. The callback accelerates them; queued retries survive a process crash. */
export function startSyntheticInterviewProcessing(){
  if(!isInterviewWorkerEnabled())return;
  after(async()=>{
    try{await processInterviewOutboxBatch(handleInterviewOutboxJob,2);}
    catch{console.error("interview_background_processing_failed");}
  });
}
