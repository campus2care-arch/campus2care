import type { Sql } from "postgres";
import { sendProductionInterviewConfirmation, type ProductionGmailInput } from "./interview-production-providers";

/** A claimed Gmail attempt is quarantined before network I/O, including after a crash. */
export async function deliverQueuedProductionMessage(
  db: Sql, objectId: string, input: ProductionGmailInput, send = sendProductionInterviewConfirmation,
): Promise<{state: "done" | "failed" | "reconcile_required"; externalId?: string; code?: string}> {
  const messages = await db<{id:string;recipient_ref:string;kind:string;state:string;gmail_message_id:string|null}[]>`
    SELECT id,recipient_ref,kind,state,gmail_message_id FROM interview.message
    WHERE operation_key=${input.operationKey} AND object_id=${objectId}`;
  const message=messages[0];
  if(!message || message.recipient_ref!==input.email || message.kind!==(input.kind??"confirmation"))
    return {state:"failed",code:"production_gmail_message_mismatch"};
  if(message.state==="accepted" && message.gmail_message_id)return {state:"done",externalId:message.gmail_message_id};
  if(message.state==="suppressed")return {state:"done"};
  if(message.state!=="queued")return {state:"reconcile_required",code:"production_gmail_previous_attempt"};
  const locked=await db<{id:string}[]>`UPDATE interview.message SET state='reconcile_required'
    WHERE id=${message.id} AND state='queued' RETURNING id`;
  if(locked.length!==1)return {state:"reconcile_required",code:"production_gmail_attempt_conflict"};
  const id=await send(input);
  await db`UPDATE interview.message SET state='accepted',
    gmail_message_id=${id},accepted_at=now() WHERE id=${message.id} AND state='reconcile_required'`;
  return {state:"done",externalId:id};
}
