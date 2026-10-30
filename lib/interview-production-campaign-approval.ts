import {createHash} from "node:crypto";
import type {Sql} from "postgres";
import {scanProductionApplicantPipelines,reviewProductionApplicantAudience,
 type ProductionPipelineApplicant,type AudienceReviewFacts} from "./interview-production-applicant-review";
import {loadProductionAudienceFacts,productionAudienceReviewDatabase} from "./interview-production-audience-facts";
import {instantToEasternLocal} from "./interview-timezone";
import type {Campus} from "./interview-notion-contract";
type Recipient={campus:Campus;pageId:string;recipientHmac:string;manualReference:string};
export type CampaignApprovalRequest={runKey:string;recipients:Recipient[];approvalDigest?:string};
export type CampaignApprovalReview={runKey:string;approvalDigest:string;audienceDigest:string;
 recipientCount:number;campusCounts:{BU:number;BC:number};recipients:Recipient[]};
export class CampaignApprovalError extends Error {
 constructor(public readonly code:string){super(code);}
}
const hex32=/^[0-9a-f]{32}$/,hex64=/^[0-9a-f]{64}$/;
const normalize=(s:string)=>s.toLowerCase().replaceAll("-","");
export function validateCampaignRunKey(runKey:string,now:Date){
 const match=/^applicant_(friday|sunday|monday):(\d{4}-\d{2}-\d{2})$/.exec(runKey);
 if(!match||!Number.isFinite(now.getTime()))throw new CampaignApprovalError("campaign_run_key_invalid");
 const date=new Date(match[2]+"T12:00:00Z"),day=date.getUTCDay();
 if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==match[2]||
   day!==({friday:5,sunday:0,monday:1}[match[1] as "friday"|"sunday"|"monday"]))
   throw new CampaignApprovalError("campaign_run_key_invalid");
 const current=instantToEasternLocal(now).date;
 const distance=(Date.parse(match[2]+"T12:00:00Z")-Date.parse(current+"T12:00:00Z"))/86400000;
 if(distance<0||distance>1)throw new CampaignApprovalError("campaign_outside_approval_window");
}
export function campaignApprovalFromSnapshot(request:CampaignApprovalRequest,input:{
 applicants:ProductionPipelineApplicant[];facts:AudienceReviewFacts;authSecret:string;now:Date;
}):CampaignApprovalReview{
 validateCampaignRunKey(request.runKey,input.now);
 if(!Array.isArray(request.recipients)||request.recipients.length<1||request.recipients.length>50)
   throw new CampaignApprovalError("campaign_recipient_count_invalid");
 const uniqueEmails=new Set<string>(),uniquePages=new Set<string>();
 const recipients:Recipient[]=[];
 for(const raw of request.recipients){
   if(!raw||!["BU","BC"].includes(raw.campus)||typeof raw.pageId!=="string"||
      typeof raw.recipientHmac!=="string"||typeof raw.manualReference!=="string")
      throw new CampaignApprovalError("campaign_recipient_invalid");
   const pageId=normalize(raw.pageId),recipientHmac=raw.recipientHmac.toLowerCase();
   if(!hex32.test(pageId)||!hex64.test(recipientHmac)||
      raw.manualReference.trim().length<8||raw.manualReference.trim().length>250)
      throw new CampaignApprovalError("campaign_recipient_invalid");
   if(uniqueEmails.has(recipientHmac)||uniquePages.has(pageId))
      throw new CampaignApprovalError("campaign_duplicate_recipient");
   uniqueEmails.add(recipientHmac);uniquePages.add(pageId);
   recipients.push({campus:raw.campus,pageId,recipientHmac,manualReference:raw.manualReference.trim()});
 }
 const reviewed=reviewProductionApplicantAudience({...input,
   facts:{...input.facts,manuallyClearedHmacs:new Set(recipients.map(r=>r.recipientHmac))}});
 const entries=new Map(reviewed.entries.map(r=>[r.campus+":"+r.pageId,r]));
 for(const row of recipients){
   const found=entries.get(row.campus+":"+row.pageId);
   if(!found||found.recipientHmac!==row.recipientHmac||
      found.decision!=="eligible_for_founder_review")
     throw new CampaignApprovalError("campaign_candidate_changed_or_ineligible");
 }
 recipients.sort((a,b)=>(a.campus+":"+a.pageId).localeCompare(b.campus+":"+b.pageId));
 const digest=createHash("sha256").update(JSON.stringify({
   version:1,runKey:request.runKey,audienceDigest:reviewed.manifestSha256,recipients,
 })).digest("hex");
 return {runKey:request.runKey,approvalDigest:digest,audienceDigest:reviewed.manifestSha256,
   recipientCount:recipients.length,
   campusCounts:{BU:recipients.filter(x=>x.campus==="BU").length,
     BC:recipients.filter(x=>x.campus==="BC").length},recipients};
}
export async function prepareProductionCampaign(request:CampaignApprovalRequest,
 deps:{scan?:()=>Promise<ProductionPipelineApplicant[]>;facts?:()=>Promise<AudienceReviewFacts>;now?:Date}={}){
 const applicants=await (deps.scan??scanProductionApplicantPipelines)();
 const facts=await (deps.facts??(()=>loadProductionAudienceFacts(productionAudienceReviewDatabase())))();
 return campaignApprovalFromSnapshot(request,{
   applicants,facts,authSecret:process.env.INTERVIEW_AUTH_SECRET??"",now:deps.now??new Date()});
}
export async function commitProductionCampaign(request:CampaignApprovalRequest,
 deps:{db?:Sql;prepare?:typeof prepareProductionCampaign;now?:Date}={}){
 if(process.env.VERCEL_ENV!=="production"||
    process.env.INTERVIEW_PRODUCTION_APPLICANT_APPROVAL_ENABLED!=="true")
   throw new CampaignApprovalError("campaign_approval_disabled");
 const now=deps.now??new Date(),review=await (deps.prepare??prepareProductionCampaign)(request,{now});
 if(!hex64.test(request.approvalDigest??"")||review.approvalDigest!==request.approvalDigest)
   throw new CampaignApprovalError("campaign_approval_digest_mismatch");
 const db=deps.db??productionAudienceReviewDatabase();
 const expiresAt=new Date(now.getTime()+60*60*1000);
 return db.begin(async tx=>{
   const added=await tx.unsafe<{id:string}[]>(
     "INSERT INTO interview.applicant_campaign_manifest (run_key,digest,audience_digest,approved_by,expected_count,expires_at) "+
     "VALUES($1,$2,$3,'president@campus2care.org',$4,$5::timestamptz) "+
     "ON CONFLICT(run_key) DO NOTHING RETURNING id",
     [request.runKey,review.approvalDigest,review.audienceDigest,review.recipientCount,expiresAt.toISOString()]);
   if(!added.length)throw new CampaignApprovalError("campaign_run_already_approved");
   for(const row of review.recipients){
     await tx.unsafe("INSERT INTO interview.applicant_campaign_recipient "+
       "(manifest_id,campus,page_id,recipient_hmac,manual_reference) VALUES($1,$2,$3,$4,$5)",
       [added[0].id,row.campus,row.pageId,row.recipientHmac,row.manualReference]);
   }
   return {manifestId:added[0].id,runKey:request.runKey,recipientCount:review.recipientCount,
     approvalDigest:review.approvalDigest,expiresAt:expiresAt.toISOString(),canSend:false};
 });
}
