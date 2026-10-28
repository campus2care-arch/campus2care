import {createHash,randomBytes,randomUUID} from "node:crypto";
import {applicantRecipientHmac} from "./interview-invitations";
import {interviewDatabase} from "./interview-db";
import {evaluateInitialInterviewEligibility} from "./interview-notion-contract";
import {previewNotionConfiguration,PreviewNotionReadError} from "./interview-notion-preview";

type NotionPage={
  object?:unknown;id?:unknown;archived?:unknown;in_trash?:unknown;
  parent?:{type?:unknown;database_id?:unknown};
  properties?:Record<string,unknown>;
};
type NotionPageList={results?:unknown;has_more?:unknown;next_cursor?:unknown};
function normalized(id:unknown):string{
  if(typeof id!=="string"||!/^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(id))
    throw new PreviewNotionReadError("pipeline_invalid_id");
  return id.replaceAll("-","").toLowerCase();
}
function select(value:unknown):string|null{
  if(!value||typeof value!=="object")return null;
  const field=value as {type?:unknown;select?:{name?:unknown}};
  return field.type==="select"&&typeof field.select?.name==="string"?field.select.name:null;
}
function email(value:unknown):string{
  if(!value||typeof value!=="object")return "";
  const field=value as {type?:unknown;email?:unknown};
  return field.type==="email"&&typeof field.email==="string"?field.email.trim().toLowerCase():"";
}
async function* pages(databaseId:string,token:string,transport:typeof fetch):AsyncGenerator<NotionPage>{
  let cursor:string|undefined;
  for(let batch=0;batch<5;batch++){
    let response:Response;
    try{response=await transport("https://api.notion.com/v1/databases/"+databaseId+"/query",{
      method:"POST",headers:{Authorization:"Bearer "+token,"Notion-Version":"2022-06-28","Content-Type":"application/json"},
      body:JSON.stringify({page_size:100,...(cursor?{start_cursor:cursor}:{})}),
      cache:"no-store",signal:AbortSignal.timeout(8000),
    });}catch{throw new PreviewNotionReadError("pipeline_scan_unreachable");}
    if(!response.ok)throw new PreviewNotionReadError("pipeline_scan_query_failed");
    let result:NotionPageList;
    try{result=await response.json() as NotionPageList;}catch{throw new PreviewNotionReadError("pipeline_scan_invalid_response");}
    if(!Array.isArray(result.results)||result.results.length>100)throw new PreviewNotionReadError("pipeline_scan_invalid_response");
    for(const page of result.results) {
      if(!page||typeof page!=="object")throw new PreviewNotionReadError("pipeline_scan_invalid_page");
      yield page as NotionPage;
    }
    if(result.has_more!==true)return;
    if(typeof result.next_cursor!=="string"||!result.next_cursor)throw new PreviewNotionReadError("pipeline_scan_invalid_cursor");
    cursor=result.next_cursor;
  }
  // Never silently treat a truncated intake as a completed scan.
  throw new PreviewNotionReadError("pipeline_scan_page_limit");
}

/**
 * Opt-in staging-only enrollment from the isolated BU/BC synthetic clones.
 * It neither reads live pipelines nor sends an email; Friday/Sunday/Monday
 * dispatch subsequently applies capacity, opt-out and rolling send limits.
 * Notion is never given a new caseload owner or volunteer availability value.
 */
export async function enrollSyntheticPipelineApplicants(transport:typeof fetch=fetch, eligibleBindings?:Set<string>):
 Promise<{enrolled:number;skipped:number;reviewed:number}>{
  if(process.env.VERCEL_ENV!=="preview"||process.env.INTERVIEW_SYNTHETIC_PIPELINE_SCAN_ENABLED!=="true"
    ||process.env.INTERVIEW_SYNTHETIC_DISPATCH_ENABLED!=="true")
    throw new PreviewNotionReadError("pipeline_scan_disabled");
  const cfg=previewNotionConfiguration();
  const db=interviewDatabase();
  let enrolled=0,skipped=0,reviewed=0;
  for(const campus of ["BU","BC"] as const){
    const expected=campus==="BU"?cfg.buId:cfg.bcId;
    for await(const page of pages(expected,cfg.token,transport)){
      reviewed++;
      if(normalized(page.parent?.database_id)!==expected||page.parent?.type!=="database_id")
        throw new PreviewNotionReadError("pipeline_scan_wrong_parent");
      const pageId=normalized(page.id);
      const properties=page.properties;
      if(page.archived===true||page.in_trash===true||!properties){skipped++;continue;}
      const recipient=email(properties.Email);
      if(!/^[a-z0-9._+-]+@example\.invalid$/.test(recipient)){skipped++;continue;}
      const eligibility=evaluateInitialInterviewEligibility(campus,{
        email:recipient,
        stage:select(properties.Stage),
        nextStep:select(properties["Next Step"]),
        interviewStatus:select(properties["Interview Status"]),
        workflowStatus:select(properties["Workflow Status"]),
      });
      if(!eligibility.eligible){skipped++;continue;}
      // This scan is also the freshness gate for already-enrolled applicants.
      // An email or stage changed in Notion must suppress the next invitation.
      eligibleBindings?.add(campus+":"+pageId+":"+recipient);
      const recipientHmac=applicantRecipientHmac(recipient);
      // The Notion page ID is a UUID; the synthetic prefix prevents its
      // reservation from ever crossing into a real-applicant provider path.
      const created=await db.begin(async tx=>{
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"interview-enrollment:"+recipientHmac},0))`;
        const existing=await tx`SELECT i.id FROM interview.invitation i
          LEFT JOIN interview.notion_staging_binding b ON b.invitation_id=i.id
          WHERE (b.page_id=${pageId}::uuid AND b.campus=${campus})
            OR (i.recipient_hmac=${recipientHmac} AND i.revoked_at IS NULL)
          LIMIT 1`;
        if(existing.length)return false;
        const id=randomUUID(),token=randomBytes(32).toString("base64url");
        await tx`INSERT INTO interview.invitation(id,campus,notion_page_id,recipient_hmac,token_hash,expires_at)
          VALUES(${id},${campus},${"synthetic-"+pageId},${recipientHmac},${createHash("sha256").update(token).digest("hex")},now()+interval '7 days')`;
        await tx`INSERT INTO interview.applicant_contact(invitation_id,email) VALUES(${id},${recipient})`;
        await tx`INSERT INTO interview.notion_staging_binding(invitation_id,campus,page_id)
          VALUES(${id},${campus},${pageId}::uuid)`;
        await tx`INSERT INTO interview.audit_event(actor_ref,action,object_type,object_id,outcome)
          VALUES('scheduler','enroll_synthetic_pipeline','invitation',${id},'awaiting_outreach')`;
        return true;
      });
      if(created)enrolled++;else skipped++;
    }
  }
  return {enrolled,skipped,reviewed};
}
