import {createHash,randomBytes,randomUUID} from "node:crypto";
import type {Sql} from "postgres";
import {productionRealConfig} from "./interview-production-launch";
import {productionInterviewDatabase} from "./interview-production-db";
import {dueInterviewDispatches,routineOutreachDecision,outreachHistoryLookbackHours} from "./interview-dispatch-policy";
import {verifyLiveCanaryApplicant} from "./interview-production-notion";
import {readInterviewTeams} from "./interview-teams";
import {sealProductionCampaignToken} from "./interview-production-campaign-crypto";
import {createHmac} from "node:crypto";
export class CampaignQueueError extends Error {constructor(public readonly code:string){super(code);}}
export function applicantCampaignSendingAuthorized(env:Record<string,string|undefined>=process.env){
  productionRealConfig(env);
  if(env.INTERVIEW_PRODUCTION_APPLICANT_CAMPAIGNS_ENABLED!=="true"||
     env.INTERVIEW_REAL_APPLICANT_SENDS_APPROVED!=="true")
    throw new CampaignQueueError("campaign_sending_not_authorized");
}
type Selected={manifest_id:string;run_key:string;digest:string;approved_by:string;
  expires_at:Date;expected_count:number;state:string;campus:"BU"|"BC";
  page_id:string;recipient_hmac:string;recipient_state:string;frequency_exception:boolean};
type Db=Sql;
/** Bounded queueing, once per exact approved recipient; never sends Gmail here. */
export async function queueApprovedApplicantCampaign(now=new Date(),deps:{
  db?:Db;verify?:typeof verifyLiveCanaryApplicant;teams?:typeof readInterviewTeams;
  gate?:typeof applicantCampaignSendingAuthorized;
  manualRunKey?:string;
}={}):Promise<{queued:number;skipped:number;blocked:string[]}>{
  (deps.gate??applicantCampaignSendingAuthorized)();
  const db=deps.db??productionInterviewDatabase();
  const verify=deps.verify??verifyLiveCanaryApplicant;
  // Invitations are not bookings: never suppress a valid outreach recipient
  // simply because other invitees might use the available interview slots.
  // The booking API independently enforces current interviewer and shadower availability.
  let queued=0,skipped=0;
  const blocked:string[]=[];
  // An approved manual batch requires a founder click to start. Only batches
  // already marked running are resumed automatically by hourly cron.
  if(deps.manualRunKey &&
      !/^applicant_manual:\d{4}-\d{2}-\d{2}:[1-9][0-9]?$/.test(deps.manualRunKey))
    throw new CampaignQueueError("campaign_manual_run_key_invalid");
  const running=deps.manualRunKey?[]:await db.unsafe<{run_key:string}[]>(
    "SELECT run_key FROM interview.applicant_campaign_manifest "+
    "WHERE run_key LIKE 'applicant_manual:%' AND state='running' "+
    "AND expires_at>now() ORDER BY approved_at LIMIT 10",[]);
  const due=deps.manualRunKey?[]:dueInterviewDispatches(now).filter(x=>x.kind.startsWith("applicant_"));
  const all=[...due,...running.map(r=>({kind:"applicant_manual",runKey:r.run_key})),
    ...(deps.manualRunKey?[{kind:"applicant_manual",runKey:deps.manualRunKey}]:[])];
  const seen=new Set<string>();
  for(const run of all){
    if(seen.has(run.runKey))continue;
    seen.add(run.runKey);
    const rows=await db.unsafe<Selected[]>(
      "SELECT m.id AS manifest_id,m.run_key,m.digest,m.approved_by,m.expires_at,m.expected_count,m.state,"+
      "c.campus,c.page_id,c.recipient_hmac,c.state AS recipient_state,c.frequency_exception "+
      "FROM interview.applicant_campaign_manifest m JOIN interview.applicant_campaign_recipient c ON c.manifest_id=m.id "+
      "WHERE m.run_key=$1 AND m.state IN ('approved','running') ORDER BY c.recipient_hmac LIMIT 101",
      [run.runKey]);
    if(!rows.length){blocked.push(run.kind+":no_approved_manifest");continue;}
    if(rows.length>100||rows.length!==rows[0].expected_count||
       rows.some(r=>r.manifest_id!==rows[0].manifest_id || r.run_key!==run.runKey ||
         r.approved_by!=="president@campus2care.org" ||
         r.expires_at.getTime()<=now.getTime())){
      blocked.push(run.kind+":manifest_invalid_or_expired");continue;
    }
    for(const row of rows){
      if(row.recipient_state!=="approved")continue;
      let candidate:{campus:"BU"|"BC";pageId:string;email:string};
      try{
        // Fail-closed live Notion read immediately before enrollment.
        const record=await db.unsafe<{email:string}[]>(
          "SELECT c.email FROM interview.invitation i JOIN interview.applicant_contact c ON c.invitation_id=i.id "+
          "WHERE i.recipient_hmac=$1 AND i.campus=$2 AND i.notion_page_id=$3 "+
          "ORDER BY i.created_at DESC LIMIT 1",[row.recipient_hmac,row.campus,row.page_id]);
        // First contact has no prior invitation. Read the exact Notion page, not a staging clone.
        const response=await fetch("https://api.notion.com/v1/pages/"+row.page_id,{
          headers:{Authorization:"Bearer "+(process.env.INTERVIEW_NOTION_LIVE_TOKEN??""),
            "Notion-Version":"2022-06-28"},cache:"no-store",signal:AbortSignal.timeout(8000)});
        if(!response.ok)throw Error("campaign_notion_lookup_unavailable");
        const page=await response.json() as {id?:string;parent?:{type?:string;database_id?:string};
          properties?:{Email?:{type?:string;email?:string}}};
        if(!page||page.id?.replaceAll("-","").toLowerCase()!==row.page_id ||
           page.properties?.Email?.type!=="email"||!page.properties.Email.email)
          throw Error("campaign_notion_record_invalid");
        const email=page.properties.Email.email.trim().toLowerCase();
        const key=process.env.INTERVIEW_AUTH_SECRET??"";
        if(key.length<32||createHmac("sha256",key).update("recipient:"+email).digest("hex")!==row.recipient_hmac)
          throw Error("campaign_email_changed");
        if(record.length && record[0].email!==email)throw Error("campaign_email_mismatch");
        await verify({campus:row.campus,pageId:row.page_id,email});
        candidate={campus:row.campus,pageId:row.page_id,email};
      }catch{skipped++;blocked.push(run.kind+":notion_identity_unavailable");continue;}
      const token=randomBytes(32).toString("base64url");
      const inviteId=randomUUID(),attemptId=randomUUID();
      const operationKey="campaign-invite:"+run.runKey+":"+inviteId;
      const payload={kind:"invitation",campus:row.campus,
        token:sealProductionCampaignToken(token,operationKey)};
      const queuedNow=await db.begin(async tx=>{
        await tx.unsafe("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[row.recipient_hmac]);
        const still=await tx.unsafe<{id:string}[]>(
          "SELECT c.manifest_id AS id FROM interview.applicant_campaign_recipient c "+
          "JOIN interview.applicant_campaign_manifest m ON m.id=c.manifest_id "+
          "WHERE c.manifest_id=$1 AND c.recipient_hmac=$2 AND c.campus=$3 AND c.page_id=$4 "+
          "AND c.state='approved' AND m.state IN ('approved','running') AND m.expires_at>now() "+
          "AND m.approved_by='president@campus2care.org' FOR UPDATE OF c,m",
          [row.manifest_id,row.recipient_hmac,row.campus,row.page_id]);
        if(!still.length)return false;
        const blocks=await tx.unsafe<{blocked:boolean}[]>(
          "SELECT (EXISTS(SELECT 1 FROM interview.recipient_suppression WHERE recipient_hmac=$1) "+
          "OR EXISTS(SELECT 1 FROM interview.reservation WHERE recipient_hmac=$1 AND status "+
          "NOT IN ('canceled','failed','expired')) "+
          "OR EXISTS(SELECT 1 FROM interview.invitation i JOIN interview.applicant_contact c ON c.invitation_id=i.id "+
          "WHERE i.recipient_hmac=$1 AND c.opted_out_at IS NOT NULL)) AS blocked",
          [row.recipient_hmac]);
        if(blocks[0]?.blocked)return false;
        const history=await tx.unsafe<{state:string;sent_at:Date|null;created_at:Date}[]>(
          "SELECT state,sent_at,created_at FROM interview.outreach_attempt "+
          "WHERE recipient_hmac=$1 AND (created_at>now()-make_interval(hours=>$2) OR "+
          "sent_at>now()-make_interval(hours=>$2) OR state IN ('queued','sending','reconcile_required'))",
          [row.recipient_hmac,outreachHistoryLookbackHours()]);
        if(routineOutreachDecision(history.map(h=>({
          state:h.state,sentAt:h.sent_at?.toISOString()??null,createdAt:h.created_at.toISOString()
        })),now.getTime(),undefined,{frequencyException:row.frequency_exception===true})!=="eligible")return false;
        // An earlier unused invitation does not disqualify an applicant who still needs an
        // interview. Revoke (never delete) it so only the newest link can book; the row and
        // its outreach_attempt history stay in Neon. Active bookings were excluded above.
        await tx.unsafe("UPDATE interview.invitation SET revoked_at=now() "+
          "WHERE recipient_hmac=$1 AND revoked_at IS NULL AND expires_at>now()",[row.recipient_hmac]);
        await tx.unsafe("INSERT INTO interview.invitation "+
          "(id,campus,notion_page_id,recipient_hmac,token_hash,expires_at) "+
          "VALUES($1,$2,$3,$4,$5,now()+interval '7 days')",
          [inviteId,row.campus,row.page_id,row.recipient_hmac,
            createHash("sha256").update(token).digest("hex")]);
        await tx.unsafe("INSERT INTO interview.applicant_contact(invitation_id,email) VALUES($1,$2)",
          [inviteId,candidate.email]);
        await tx.unsafe("INSERT INTO interview.outreach_attempt "+
          "(id,campus,notion_page_id,recipient_hmac,campaign_type,run_key) "+
          "VALUES($1,$2,$3,$4,$5,$6)",
          [attemptId,row.campus,row.page_id,row.recipient_hmac,
            history.some(x=>x.state==="sent")?"reminder":"initial_invite",run.runKey]);
        await tx.unsafe("INSERT INTO interview.message "+
          "(id,operation_key,recipient_ref,kind,campus,object_id,payload) "+
          "VALUES($1,$2,$3,'invitation',$4,$5,$6::jsonb)",
          [attemptId,operationKey,candidate.email,row.campus,inviteId,JSON.stringify(payload)]);
        await tx.unsafe("INSERT INTO interview.integration_outbox "+
          "(operation_key,provider,action,object_id) VALUES($1,'gmail','send_message',$2)",
          [operationKey,attemptId]);
        await tx.unsafe("UPDATE interview.applicant_campaign_recipient "+
          "SET state='queued',invitation_id=$1,updated_at=now() "+
          "WHERE manifest_id=$2 AND recipient_hmac=$3",
          [inviteId,row.manifest_id,row.recipient_hmac]);
        await tx.unsafe("UPDATE interview.applicant_campaign_manifest "+
          "SET state='running' WHERE id=$1 AND state='approved'",[row.manifest_id]);
        return true;
      });
      if(queuedNow)queued++;else skipped++;
      if(queued>=20)break; // bounded per invocation, remaining recipients are retried by cron.
    }
  }
  return {queued,skipped,blocked:[...new Set(blocked)]};
}
