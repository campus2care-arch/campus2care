import {createHash,randomBytes,randomUUID} from "node:crypto";
import type {Sql} from "postgres";
import {productionRealConfig} from "./interview-production-launch";
import {productionInterviewDatabase} from "./interview-production-db";
import {dueInterviewDispatches,routineOutreachDecision} from "./interview-dispatch-policy";
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
  page_id:string;recipient_hmac:string;recipient_state:string};
type Db=Sql;
/** Bounded queueing, once per exact approved recipient; never sends Gmail here. */
export async function queueApprovedApplicantCampaign(now=new Date(),deps:{
  db?:Db;verify?:typeof verifyLiveCanaryApplicant;teams?:typeof readInterviewTeams;
  gate?:typeof applicantCampaignSendingAuthorized;
}={}):Promise<{queued:number;skipped:number;blocked:string[]}>{
  (deps.gate??applicantCampaignSendingAuthorized)();
  const db=deps.db??productionInterviewDatabase();
  const verify=deps.verify??verifyLiveCanaryApplicant;
  const teams=await (deps.teams??readInterviewTeams)(db);
  // Approved appearance is NOT proof of capacity: verify lead activation and
  // overlapping claims for every lead/shadower in the exact scheduled slot.
  const openSlots=await db.unsafe<{id:string}[]>(
    "SELECT s.id FROM interview.schedule_slot s "+
    "JOIN interview.interviewer lead ON lead.id=s.lead_id "+
    "WHERE s.approved_by='president@campus2care.org' AND lead.active "+
    "AND s.campus=ANY(lead.allowed_campuses) AND lead.weekly_capacity_limit>0 "+
    "AND s.starts_at>now()+interval '30 minutes' "+
    "AND s.starts_at<now()+interval '14 days' "+
    "AND (SELECT count(*) FROM interview.slot_claim wc WHERE wc.interviewer_id=lead.id "+
    "AND wc.claim_key NOT LIKE '%:participant:%' AND "+
    "date_trunc('week',wc.starts_at AT TIME ZONE 'America/New_York')="+
    "date_trunc('week',s.starts_at AT TIME ZONE 'America/New_York')) < lead.weekly_capacity_limit "+
    "AND NOT EXISTS (SELECT 1 FROM interview.schedule_participant p "+
    "JOIN interview.slot_claim c ON c.interviewer_id=p.participant_id "+
    "WHERE p.slot_id=s.id AND tstzrange(c.starts_at,c.blocks_until,'[)') "+
    "&& tstzrange(s.starts_at,s.starts_at+interval '20 minutes','[)'))",[]);
  const openIds=new Set(openSlots.map(s=>s.id));
  const viableCampuses=new Set(teams.filter(t=>openIds.has(t.id) &&
    t.approvedBy==="president@campus2care.org" &&
    new Date(t.startsAt).getTime()>now.getTime()+30*60000 &&
    t.participants.length>=2 && t.participants.filter(p=>p.role==="lead").length===1 &&
    t.participants.every(p=>p.available && p.email.endsWith("@campus2care.org")))
      .map(t=>t.campus));
  let queued=0,skipped=0;
  const blocked:string[]=[];
  for(const run of dueInterviewDispatches(now).filter(x=>x.kind.startsWith("applicant_"))){
    const rows=await db.unsafe<Selected[]>(
      "SELECT m.id AS manifest_id,m.run_key,m.digest,m.approved_by,m.expires_at,m.expected_count,m.state,"+
      "c.campus,c.page_id,c.recipient_hmac,c.state AS recipient_state "+
      "FROM interview.applicant_campaign_manifest m JOIN interview.applicant_campaign_recipient c ON c.manifest_id=m.id "+
      "WHERE m.run_key=$1 AND m.state IN ('approved','running') ORDER BY c.recipient_hmac LIMIT 51",
      [run.runKey]);
    if(!rows.length){blocked.push(run.kind+":no_approved_manifest");continue;}
    if(rows.length>50||rows.length!==rows[0].expected_count||
       rows.some(r=>r.manifest_id!==rows[0].manifest_id || r.run_key!==run.runKey ||
         r.approved_by!=="president@campus2care.org" ||
         r.expires_at.getTime()<=now.getTime())){
      blocked.push(run.kind+":manifest_invalid_or_expired");continue;
    }
    for(const row of rows){
      if(row.recipient_state!=="approved")continue;
      if(!viableCampuses.has(row.campus)){skipped++;blocked.push(run.kind+":no_bookable_team");continue;}
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
          "WHERE i.recipient_hmac=$1 AND c.opted_out_at IS NOT NULL) "+
          "OR EXISTS(SELECT 1 FROM interview.invitation WHERE recipient_hmac=$1 "+
          "AND revoked_at IS NULL AND expires_at>now())) AS blocked",
          [row.recipient_hmac]);
        if(blocks[0]?.blocked)return false;
        const history=await tx.unsafe<{state:string;sent_at:Date|null;created_at:Date}[]>(
          "SELECT state,sent_at,created_at FROM interview.outreach_attempt "+
          "WHERE recipient_hmac=$1 AND (created_at>now()-interval '7 days' OR "+
          "sent_at>now()-interval '7 days' OR state IN ('queued','sending','reconcile_required'))",
          [row.recipient_hmac]);
        if(routineOutreachDecision(history.map(h=>({
          state:h.state,sentAt:h.sent_at?.toISOString()??null,createdAt:h.created_at.toISOString()
        })),now.getTime())!=="eligible")return false;
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
