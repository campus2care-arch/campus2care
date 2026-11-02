import {NextRequest,NextResponse} from "next/server";
import {staffFromRequest,interviewBaseOrigin} from "../../../../../lib/interview-auth";
import {productionInterviewDatabase} from "../../../../../lib/interview-production-db";
import {applicantCampaignSendingAuthorized} from "../../../../../lib/interview-production-campaign-queue";
import {processProductionCampaignOutbox} from "../../../../../lib/interview-production-campaign-mail";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
const headers={"Cache-Control":"no-store, private","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff"};
const reply=(status:number,data:object)=>NextResponse.json(data,{status,headers});

/** Founder-confirmed retry for exact held recipients after checking both Sent mailboxes. */
export async function POST(request:NextRequest){
  if(process.env.VERCEL_ENV!=="production")return reply(404,{ok:false,error:"production_only"});
  const staff=staffFromRequest(request);
  if(staff?.role!=="admin"||staff.email!=="president@campus2care.org")
    return reply(403,{ok:false,error:"founder_access_required"});
  if(request.headers.get("origin")!==interviewBaseOrigin(request)||
     !request.headers.get("content-type")?.startsWith("application/json"))
    return reply(403,{ok:false,error:"invalid_request_origin"});
  let runKey="",emails:string[]=[];
  try{
    const body=await request.json() as {runKey?:unknown;emails?:unknown;confirmedNotSent?:unknown};
    if(typeof body.runKey!=="string"||!/^applicant_manual:\d{4}-\d{2}-\d{2}:[1-9][0-9]?$/.test(body.runKey)||
       !Array.isArray(body.emails)||!body.emails.length||body.emails.length>100||body.confirmedNotSent!==true||
       body.emails.some(email=>typeof email!=="string"||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
      return reply(400,{ok:false,error:"held_send_confirmation_invalid"});
    runKey=body.runKey;
    emails=[...new Set((body.emails as string[]).map(email=>email.trim().toLowerCase()))];
    if(!emails.length||emails.length>100)return reply(400,{ok:false,error:"held_send_confirmation_invalid"});
  }catch{return reply(400,{ok:false,error:"invalid_request"});}
  try{
    applicantCampaignSendingAuthorized();
    const db=productionInterviewDatabase();
    await db.begin(async tx=>{
      const records=await tx.unsafe<{
        manifest_id:string;manifest_state:string;approved_by:string;expires_at:Date;
        email:string;recipient_state:string;invitation_id:string;message_id:string;message_state:string;
        outbox_id:string;outbox_state:string;error_code:string|null;external_id:string|null;
        gmail_message_id:string|null;attempt_state:string;
      }[]>(
        "SELECT m.id AS manifest_id,m.state AS manifest_state,m.approved_by,m.expires_at,lower(c.email) AS email, "+
        "r.state AS recipient_state,i.id AS invitation_id,msg.id AS message_id,msg.state AS message_state, "+
        "j.id AS outbox_id,j.state AS outbox_state,j.last_error_code AS error_code,j.external_id, "+
        "msg.gmail_message_id,o.state AS attempt_state "+
        "FROM interview.applicant_campaign_manifest m "+
        "JOIN interview.applicant_campaign_recipient r ON r.manifest_id=m.id "+
        "JOIN interview.invitation i ON i.id=r.invitation_id "+
        "JOIN interview.applicant_contact c ON c.invitation_id=i.id "+
        "JOIN interview.message msg ON msg.object_id=i.id AND msg.kind='invitation' "+
        "JOIN interview.integration_outbox j ON j.object_id=msg.id AND j.provider='gmail' AND j.action='send_message' "+
        "JOIN interview.outreach_attempt o ON o.id=msg.id AND o.run_key=m.run_key "+
        "WHERE m.run_key=$1 AND lower(c.email)=ANY($2::text[]) "+
        "FOR UPDATE OF m,r,i,msg,j,o",[runKey,emails]);
      if(records.length!==emails.length||new Set(records.map(row=>row.email)).size!==emails.length)
        throw Error("held_invitation_not_retryable");
      for(const row of records){
        if(row.approved_by!=="president@campus2care.org"||
           !["approved","running"].includes(row.manifest_state)||row.expires_at.getTime()<=Date.now())
          throw Error("held_invitation_not_retryable");
        if(row.recipient_state==="sent"&&row.message_state==="accepted"&&row.outbox_state==="done"&&
           row.attempt_state==="sent"&&!!row.external_id&&row.external_id===row.gmail_message_id)continue;
        const held=row.recipient_state==="reconcile_required"&&row.message_state==="reconcile_required"&&
          row.outbox_state==="reconcile_required"&&row.attempt_state==="reconcile_required"&&
          ["campaign_gmail_outcome_uncertain","campaign_worker_lease_expired"].includes(row.error_code??"");
        const queued=row.recipient_state==="queued"&&row.message_state==="queued"&&
          row.outbox_state==="queued"&&row.attempt_state==="queued";
        if(row.external_id!==null||row.gmail_message_id!==null||(!held&&!queued))
          throw Error("held_invitation_not_retryable");
      }
      for(const row of records){
        if(row.recipient_state==="sent")continue;
        if(row.recipient_state==="queued")continue;
        const outbox=await tx.unsafe<{id:string}[]>(
          "UPDATE interview.integration_outbox SET state='queued',next_attempt_at=now(),lease_until=NULL, "+
          "last_error_code=NULL,updated_at=now() WHERE id=$1 AND state='reconcile_required' "+
          "AND external_id IS NULL RETURNING id",[row.outbox_id]);
        const message=await tx.unsafe<{id:string}[]>(
          "UPDATE interview.message SET state='queued' WHERE id=$1 AND state='reconcile_required' "+
          "AND gmail_message_id IS NULL RETURNING id",[row.message_id]);
        const attempt=await tx.unsafe<{id:string}[]>(
          "UPDATE interview.outreach_attempt SET state='queued',last_error_code=NULL "+
          "WHERE id=$1 AND state='reconcile_required' RETURNING id",[row.message_id]);
        const recipient=await tx.unsafe<{recipient_hmac:string}[]>(
          "UPDATE interview.applicant_campaign_recipient SET state='queued',updated_at=now() "+
          "WHERE manifest_id=$1 AND invitation_id=$2 AND state='reconcile_required' RETURNING recipient_hmac",
          [row.manifest_id,row.invitation_id]);
        if(outbox.length!==1||message.length!==1||attempt.length!==1||recipient.length!==1)
          throw Error("held_invitation_state_changed");
        await tx.unsafe(
          "INSERT INTO interview.audit_event(actor_ref,action,object_type,object_id,outcome,metadata) "+
          "VALUES($1,'campaign_held_invitation_retry_authorized','applicant_campaign_recipient',$2,'queued',$3::jsonb)",
          [staff.email,runKey+":"+row.email,
            tx.json({email:row.email,source:"founder_confirmed_absent_from_both_sent_mailboxes"})]);
      }
      await tx.unsafe("UPDATE interview.applicant_campaign_manifest SET state='running' WHERE run_key=$1 AND state='approved'",[runKey]);
    });
    const processed=await processProductionCampaignOutbox(db,5,{}, {runKey,emails});
    const counts=await db.unsafe<{state:string;count:number}[]>(
      "SELECT r.state,count(*)::int AS count FROM interview.applicant_campaign_recipient r "+
      "JOIN interview.applicant_campaign_manifest m ON m.id=r.manifest_id "+
      "JOIN interview.applicant_contact c ON c.invitation_id=r.invitation_id "+
      "WHERE m.run_key=$1 AND lower(c.email)=ANY($2::text[]) GROUP BY r.state",[runKey,emails]);
    return reply(200,{ok:true,runKey,sent:processed.sent,suppressed:processed.suppressed,
      reconciliation:processed.reconciliation,counts:Object.fromEntries(counts.map(x=>[x.state,x.count]))});
  }catch(error){
    const code=error instanceof Error&&["held_invitation_not_retryable","held_invitation_state_changed"].includes(error.message)
      ?error.message:"campaign_send_unavailable_or_not_authorized";
    return reply(code==="held_invitation_not_retryable"||code==="held_invitation_state_changed"?409:503,{ok:false,error:code});
  }
}
