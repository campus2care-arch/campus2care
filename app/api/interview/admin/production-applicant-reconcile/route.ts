import {NextRequest,NextResponse} from "next/server";
import {staffFromRequest,interviewBaseOrigin} from "../../../../../lib/interview-auth";
import {requireProductionAudienceReview} from "../../../../../lib/interview-production-applicant-review";
import {productionAudienceReviewDatabase} from "../../../../../lib/interview-production-audience-facts";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"no-store, private","Referrer-Policy":"no-referrer",
  "X-Content-Type-Options":"nosniff"};
const reply=(status:number,data:object)=>NextResponse.json(data,{status,headers});

/** Record a founder-verified Gmail acceptance. This action never sends or retries mail. */
export async function POST(request:NextRequest){
  if(process.env.VERCEL_ENV!=="production")return reply(404,{ok:false,error:"production_only"});
  const staff=staffFromRequest(request);
  if(staff?.role!=="admin"||staff.email!=="president@campus2care.org")
    return reply(403,{ok:false,error:"founder_access_required"});
  if(request.headers.get("origin")!==interviewBaseOrigin(request)||
     !request.headers.get("content-type")?.startsWith("application/json"))
    return reply(403,{ok:false,error:"invalid_request_origin"});
  let runKey="",email="",gmailMessageId="";
  try{
    const body=await request.json() as {runKey?:unknown;email?:unknown;gmailMessageId?:unknown;confirmed?:unknown};
    if(typeof body.runKey!=="string"||!/^applicant_(?:(?:friday|sunday|monday):\d{4}-\d{2}-\d{2}|manual:\d{4}-\d{2}-\d{2}:[1-9][0-9]?)$/.test(body.runKey)||
       typeof body.email!=="string"||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)||
       typeof body.gmailMessageId!=="string"||!/^[A-Za-z0-9_-]{5,200}$/.test(body.gmailMessageId)||
       body.confirmed!==true)
      return reply(400,{ok:false,error:"reconciliation_confirmation_invalid"});
    runKey=body.runKey;email=body.email.trim().toLowerCase();gmailMessageId=body.gmailMessageId;
  }catch{return reply(400,{ok:false,error:"invalid_request"});}
  try{
    requireProductionAudienceReview();
    const db=productionAudienceReviewDatabase();
    await db.begin(async tx=>{
      const records=await tx.unsafe<{
        manifest_id:string;recipient_hmac:string;invitation_id:string;message_id:string;outbox_id:string;
      }[]>(
        "SELECT m.id AS manifest_id,r.recipient_hmac,i.id AS invitation_id,msg.id AS message_id,j.id AS outbox_id "+
        "FROM interview.applicant_campaign_manifest m "+
        "JOIN interview.applicant_campaign_recipient r ON r.manifest_id=m.id "+
        "JOIN interview.invitation i ON i.id=r.invitation_id "+
        "JOIN interview.applicant_contact c ON c.invitation_id=i.id "+
        "JOIN interview.message msg ON msg.object_id=i.id AND msg.kind='invitation' "+
        "JOIN interview.integration_outbox j ON j.object_id=msg.id AND j.provider='gmail' AND j.action='send_message' "+
        "WHERE m.run_key=$1 AND lower(c.email)=lower($2) AND r.state='reconcile_required' "+
        "AND msg.state='reconcile_required' AND msg.gmail_message_id IS NULL "+
        "AND j.state='reconcile_required' AND j.external_id IS NULL "+
        "AND j.operation_key=msg.operation_key AND i.revoked_at IS NULL "+
        "FOR UPDATE OF r,msg,j",[runKey,email]);
      if(records.length!==1)throw Error("reconciliation_record_not_found_or_changed");
      const record=records[0];
      const duplicate=await tx.unsafe<{id:string}[]>(
        "SELECT id FROM interview.message WHERE gmail_message_id=$1 LIMIT 1",[gmailMessageId]);
      if(duplicate.length)throw Error("gmail_message_id_already_recorded");
      const message=await tx.unsafe<{id:string}[]>(
        "UPDATE interview.message SET state='accepted',gmail_message_id=$2,accepted_at=now() "+
        "WHERE id=$1 AND state='reconcile_required' AND gmail_message_id IS NULL RETURNING id",
        [record.message_id,gmailMessageId]);
      const outbox=await tx.unsafe<{id:string}[]>(
        "UPDATE interview.integration_outbox SET state='done',external_id=$2, "+
        "last_error_code='campaign_gmail_acceptance_verified_by_founder',lease_until=NULL,updated_at=now() "+
        "WHERE id=$1 AND state='reconcile_required' AND external_id IS NULL RETURNING id",
        [record.outbox_id,gmailMessageId]);
      const attempt=await tx.unsafe<{id:string}[]>(
        "UPDATE interview.outreach_attempt SET state='sent',gmail_message_id=$2,sent_at=COALESCE(sent_at,now()), "+
        "last_error_code='campaign_gmail_acceptance_verified_by_founder' "+
        "WHERE id=$1 AND state IN ('reconcile_required','sending') AND gmail_message_id IS NULL RETURNING id",
        [record.message_id,gmailMessageId]);
      const recipient=await tx.unsafe<{recipient_hmac:string}[]>(
        "UPDATE interview.applicant_campaign_recipient SET state='sent',updated_at=now() "+
        "WHERE manifest_id=$1 AND recipient_hmac=$2 AND invitation_id=$3 AND state='reconcile_required' "+
        "RETURNING recipient_hmac",[record.manifest_id,record.recipient_hmac,record.invitation_id]);
      if(message.length!==1||outbox.length!==1||attempt.length!==1||recipient.length!==1)
        throw Error("reconciliation_state_changed");
      await tx.unsafe(
        "INSERT INTO interview.audit_event(actor_ref,action,object_type,object_id,outcome,metadata) "+
        "VALUES($1,'campaign_gmail_acceptance_verified','applicant_campaign_recipient',$2,'recorded',$3::jsonb)",
        [staff.email,runKey+":"+record.recipient_hmac,
          tx.json({email,gmailMessageId,source:"contact_sent_founder_verified"})]);
      await tx.unsafe(
        "UPDATE interview.applicant_campaign_manifest SET state='complete' WHERE id=$1 "+
        "AND NOT EXISTS(SELECT 1 FROM interview.applicant_campaign_recipient "+
        "WHERE manifest_id=$1 AND state NOT IN ('sent','suppressed'))",[record.manifest_id]);
    });
    return reply(200,{ok:true,recorded:true,runKey,email,
      note:"Recorded as accepted after founder verification in contact@ Sent. No email was sent."});
  }catch(error){
    const code=error instanceof Error&&[
      "reconciliation_record_not_found_or_changed","gmail_message_id_already_recorded",
      "reconciliation_state_changed"
    ].includes(error.message)?error.message:"campaign_reconciliation_unavailable";
    return reply(code==="campaign_reconciliation_unavailable"?503:409,{ok:false,error:code});
  }
}
