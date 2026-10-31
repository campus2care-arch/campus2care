import {createHash} from "node:crypto";
import type {Sql} from "postgres";
import {productionRealConfig} from "./interview-production-launch";
import {productionInterviewDatabase} from "./interview-production-db";
import {productionGoogleAccessToken} from "./interview-production-providers";
import {renderInterviewMessage} from "./interview-email";
import {verifyLiveCanaryApplicant} from "./interview-production-notion";
import {openProductionCampaignToken,type SealedCampaignToken} from "./interview-production-campaign-crypto";
import {applicantCampaignSendingAuthorized} from "./interview-production-campaign-queue";
import {routineOutreachDecision,outreachHistoryLookbackHours} from "./interview-dispatch-policy";
export type CampaignDelivery={operationKey:string;campus:"BU"|"BC";pageId:string;email:string;token:string};
type Job={id:string;operation_key:string;message_id:string;invitation_id:string;
 campus:"BU"|"BC";page_id:string;recipient_hmac:string;email:string;
 payload:{token?:SealedCampaignToken};manifest_id:string;expires_at:Date;frequency_exception:boolean};
export async function sendProductionCampaignInvitation(input:CampaignDelivery,transport:typeof fetch=fetch){
  applicantCampaignSendingAuthorized(); productionRealConfig();
  if(!/^campaign-invite:applicant_(friday|sunday|monday):\d{4}-\d{2}-\d{2}:[a-f0-9-]{36}$/.test(input.operationKey)||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)||!["BU","BC"].includes(input.campus)||
    !/^[A-Za-z0-9_-]{40,80}$/.test(input.token))
    throw Error("campaign_delivery_invalid");
  // The fragment is stripped by browsers before HTTP, so invitation secrets
  // do not enter the web server's request logs.
  const base=process.env.INTERVIEW_BASE_URL??"";
  let verifiedOrigin:string;
  try{
    const url=new URL(base);
    if(url.protocol!=="https:"||url.pathname!=="/"||url.username||url.password||
       url.search||url.hash||!["campus2care.org","www.campus2care.org"].includes(url.hostname))
      throw Error("invalid_base");
    verifiedOrigin=url.origin;
  }catch{throw Error("campaign_public_origin_invalid");}
  const link=verifiedOrigin+"/interview#token="+encodeURIComponent(input.token);
  const view=renderInterviewMessage({kind:"invitation",campus:input.campus,
    recipient:input.email,operationKey:input.operationKey,link});
  const digest=createHash("sha256").update(input.operationKey).digest("hex");
  const boundary="c2c_"+digest;
  const mime=[
    "From: Campus2Care <contact@campus2care.org>","To: "+input.email,
    "Reply-To: contact@campus2care.org","Subject: "+view.subject,
    "Message-ID: <"+digest+"@campus2care.org>","MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="'+boundary+'"',"",
    "--"+boundary,'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64","",Buffer.from(view.text).toString("base64"),
    "--"+boundary,'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64","",Buffer.from(view.html).toString("base64"),
    "--"+boundary+"--","",
  ].join("\r\n");
  const access=await productionGoogleAccessToken("gmail",transport);
  let response:Response;
  try{response=await transport("https://gmail.googleapis.com/gmail/v1/users/me/messages/send",{
    method:"POST",headers:{Authorization:"Bearer "+access,"Content-Type":"application/json"},
    body:JSON.stringify({raw:Buffer.from(mime).toString("base64url")}),
    cache:"no-store",signal:AbortSignal.timeout(10000),
  });}catch{throw Error("campaign_gmail_outcome_uncertain");}
  if(!response.ok)throw Error("campaign_gmail_outcome_uncertain");
  let result:{id?:unknown};
  try{result=await response.json() as {id?:unknown};}
  catch{throw Error("campaign_gmail_outcome_uncertain");}
  if(typeof result.id!=="string"||!/^[A-Za-z0-9_-]{5,200}$/.test(result.id))
    throw Error("campaign_gmail_outcome_uncertain");
  return result.id;
}
/** Claim once. Never automatically replay an ambiguous Gmail send. */
export async function processProductionCampaignOutbox(db:Sql=productionInterviewDatabase(),limit=5,deps:{
  verify?:typeof verifyLiveCanaryApplicant;deliver?:typeof sendProductionCampaignInvitation;
}={}):Promise<{claimed:number;sent:number;suppressed:number;reconciliation:number}>{
  applicantCampaignSendingAuthorized();
  if(!Number.isInteger(limit)||limit<1||limit>5)throw Error("campaign_worker_limit_invalid");
  // A crashed worker cannot safely infer whether Gmail accepted a message.
  // Quarantine expired processing leases rather than ever replaying the send.
  await db.begin(async tx=>{
    const expired=await tx.unsafe<{object_id:string}[]>(
      "UPDATE interview.integration_outbox SET state='reconcile_required',"+
      "last_error_code='campaign_worker_lease_expired',lease_until=NULL,updated_at=now() "+
      "WHERE provider='gmail' AND action='send_message' AND state='processing' "+
      "AND lease_until<now() AND operation_key LIKE 'campaign-invite:applicant_%' "+
      "RETURNING object_id",[]);
    for(const row of expired){
      await tx.unsafe("UPDATE interview.message SET state='reconcile_required' "+
        "WHERE id=$1 AND state='queued'",[row.object_id]);
      await tx.unsafe("UPDATE interview.outreach_attempt SET state='reconcile_required', "+
        "last_error_code='campaign_worker_lease_expired' "+
        "WHERE id=$1 AND state IN ('queued','sending')",[row.object_id]);
      await tx.unsafe("UPDATE interview.applicant_campaign_recipient SET "+
        "state='reconcile_required',updated_at=now() WHERE invitation_id=("+
        "SELECT object_id FROM interview.message WHERE id=$1) AND state='queued'",
        [row.object_id]);
    }
  });

  let claimed=0,sent=0,suppressed=0,reconciliation=0;
  for(let n=0;n<limit;n++){
    const candidates=await db.unsafe<Job[]>(
      "WITH candidate AS (SELECT j.id FROM interview.integration_outbox j "+
      "JOIN interview.message m ON m.id=j.object_id "+
      "JOIN interview.invitation i ON i.id=m.object_id "+
      "JOIN interview.applicant_contact c ON c.invitation_id=i.id "+
      "JOIN interview.applicant_campaign_recipient r ON r.invitation_id=i.id "+
      "JOIN interview.applicant_campaign_manifest a ON a.id=r.manifest_id "+
      "JOIN interview.outreach_attempt o ON o.id=m.id AND o.run_key=a.run_key "+
      "WHERE j.provider='gmail' AND j.action='send_message' AND j.state='queued' "+
      "AND j.next_attempt_at<=now() AND j.operation_key=m.operation_key "+
      "AND m.kind='invitation' AND m.state='queued' AND o.state='queued' "+
      "AND r.state='queued' AND a.state='running' "+
      "AND i.revoked_at IS NULL AND i.expires_at>now() AND c.opted_out_at IS NULL "+
      "AND r.recipient_hmac=i.recipient_hmac AND r.page_id=i.notion_page_id "+
      "AND r.campus=i.campus AND m.recipient_ref=c.email AND m.campus=i.campus "+
      "AND j.operation_key='campaign-invite:'||a.run_key||':'||i.id::text "+
      "ORDER BY j.next_attempt_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1) "+
      "UPDATE interview.integration_outbox j SET state='processing',attempts=j.attempts+1,"+
      "lease_until=now()+interval '120 seconds',updated_at=now() "+
      "FROM candidate,interview.message m,interview.invitation i,interview.applicant_contact c,"+
      "interview.applicant_campaign_recipient r,interview.applicant_campaign_manifest a "+
      "WHERE j.id=candidate.id AND m.id=j.object_id AND i.id=m.object_id "+
      "AND c.invitation_id=i.id AND r.invitation_id=i.id AND a.id=r.manifest_id "+
      "RETURNING j.id,j.operation_key,m.id AS message_id,i.id AS invitation_id,i.campus,"+
      "i.notion_page_id AS page_id,i.recipient_hmac,c.email,m.payload,"+
      "a.id AS manifest_id,a.expires_at,r.frequency_exception",
      []);
    const job=candidates[0];if(!job)break;claimed++;
    const quarantine=async(code:string)=>{
      await db.begin(async tx=>{
        await tx.unsafe("UPDATE interview.integration_outbox SET state='reconcile_required',"+
          "lease_until=NULL,last_error_code=$2,updated_at=now() WHERE id=$1 AND state='processing'",
          [job.id,code]);
        await tx.unsafe("UPDATE interview.message SET state='reconcile_required' "+
          "WHERE id=$1 AND state='queued'",[job.message_id]);
        await tx.unsafe("UPDATE interview.outreach_attempt SET state='reconcile_required',"+
          "last_error_code=$2 WHERE id=$1 AND state IN ('queued','sending')",[job.message_id,code]);
        await tx.unsafe("UPDATE interview.applicant_campaign_recipient "+
          "SET state='reconcile_required',updated_at=now() WHERE invitation_id=$1",
          [job.invitation_id]);
      });
      reconciliation++;
    };
    const suppress=async(reason:string)=>{
      await db.begin(async tx=>{
        await tx.unsafe("UPDATE interview.integration_outbox SET state='done',lease_until=NULL,"+
          "last_error_code=$2,updated_at=now() WHERE id=$1 AND state='processing'",[job.id,reason]);
        await tx.unsafe("UPDATE interview.message SET state='suppressed' WHERE id=$1 AND state='queued'",
          [job.message_id]);
        await tx.unsafe("UPDATE interview.outreach_attempt SET state='suppressed',last_error_code=$2 "+
          "WHERE id=$1 AND state='queued'",[job.message_id,reason]);
        await tx.unsafe("UPDATE interview.applicant_campaign_recipient "+
          "SET state='suppressed',updated_at=now() WHERE invitation_id=$1",[job.invitation_id]);
        await tx.unsafe("UPDATE interview.invitation SET revoked_at=now() "+
          "WHERE id=$1 AND revoked_at IS NULL",[job.invitation_id]);
      });
      suppressed++;
    };
    if(job.expires_at.getTime()<=Date.now()){await suppress("campaign_manifest_expired");continue;}
    try{
      await (deps.verify??verifyLiveCanaryApplicant)({
        campus:job.campus,pageId:job.page_id,email:job.email});
    }catch{await quarantine("campaign_notion_revalidation_failed");continue;}
    const block=await db.unsafe<{blocked:boolean}[]>(
      "SELECT (EXISTS(SELECT 1 FROM interview.recipient_suppression WHERE recipient_hmac=$1) "+
      "OR EXISTS(SELECT 1 FROM interview.reservation WHERE recipient_hmac=$1 AND status "+
      "NOT IN ('canceled','failed','expired')) "+
      "OR EXISTS(SELECT 1 FROM interview.applicant_contact c JOIN interview.invitation i "+
      "ON i.id=c.invitation_id WHERE i.recipient_hmac=$1 AND c.opted_out_at IS NOT NULL) "+
      "OR EXISTS(SELECT 1 FROM interview.outreach_attempt "+
      "WHERE recipient_hmac=$1 AND id<>$2 AND state IN ('queued','sending','reconcile_required'))) AS blocked",
      [job.recipient_hmac,job.message_id]);
    if(block[0]?.blocked){await suppress("campaign_recipient_ineligible_at_send");continue;}
    const prior=await db.unsafe<{state:string;sent_at:Date|null;created_at:Date}[]>(
      "SELECT state,sent_at,created_at FROM interview.outreach_attempt "+
      "WHERE recipient_hmac=$1 AND id<>$2 AND (created_at>now()-make_interval(hours=>$3) "+
      "OR sent_at>now()-make_interval(hours=>$3) OR state IN ('queued','sending','reconcile_required'))",
      [job.recipient_hmac,job.message_id,outreachHistoryLookbackHours()]);
    if(routineOutreachDecision(prior.map(x=>({
      state:x.state,sentAt:x.sent_at?.toISOString()??null,
      createdAt:x.created_at.toISOString()
    })),Date.now(),undefined,{frequencyException:job.frequency_exception===true})!=="eligible"){
      await suppress("campaign_outreach_spacing_changed");continue;
    }
    let token:string;
    try{
      token=openProductionCampaignToken(job.payload.token!,job.operation_key);
      const stored=await db.unsafe<{token_hash:string}[]>(
        "SELECT token_hash FROM interview.invitation WHERE id=$1 AND revoked_at IS NULL "+
        "AND expires_at>now() LIMIT 1",[job.invitation_id]);
      if(!stored.length||stored[0].token_hash!==createHash("sha256").update(token).digest("hex"))
        throw Error("campaign_token_hash_changed");
    }catch{await quarantine("campaign_token_reconciliation_required");continue;}
    // Durable uncertainty marker BEFORE external I/O; crash will not retry.
    const locked=await db.begin(async tx=>{
      const m=await tx.unsafe<{id:string}[]>(
        "UPDATE interview.message SET state='reconcile_required' "+
        "WHERE id=$1 AND state='queued' RETURNING id",[job.message_id]);
      if(!m.length)return false;
      await tx.unsafe("UPDATE interview.outreach_attempt SET state='sending' "+
        "WHERE id=$1 AND state='queued'",[job.message_id]);
      return true;
    });
    if(!locked){await quarantine("campaign_message_claim_conflict");continue;}
    let gmailId:string;
    try{
      gmailId=await (deps.deliver??sendProductionCampaignInvitation)({
        operationKey:job.operation_key,campus:job.campus,
        pageId:job.page_id,email:job.email,token});
    }catch{await quarantine("campaign_gmail_outcome_uncertain");continue;}
    await db.begin(async tx=>{
      await tx.unsafe("UPDATE interview.message SET state='accepted',gmail_message_id=$2,"+
        "accepted_at=now() WHERE id=$1 AND state='reconcile_required'",[job.message_id,gmailId]);
      await tx.unsafe("UPDATE interview.outreach_attempt SET state='sent',sent_at=now(),"+
        "gmail_message_id=$2 WHERE id=$1 AND state='sending'",[job.message_id,gmailId]);
      await tx.unsafe("UPDATE interview.integration_outbox SET state='done',external_id=$2,"+
        "last_error_code=NULL,lease_until=NULL,updated_at=now() "+
        "WHERE id=$1 AND state='processing'",[job.id,gmailId]);
      await tx.unsafe("UPDATE interview.applicant_campaign_recipient SET state='sent',"+
        "updated_at=now() WHERE invitation_id=$1 AND state='queued'",[job.invitation_id]);
      await tx.unsafe("UPDATE interview.applicant_campaign_manifest SET state='complete' "+
        "WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM interview.applicant_campaign_recipient "+
        "WHERE manifest_id=$1 AND state NOT IN ('sent','suppressed'))",[job.manifest_id]);
    });
    sent++;
  }
  return {claimed,sent,suppressed,reconciliation};
}
