import { previewNotionConfiguration, PreviewNotionReadError } from "./interview-notion-preview";
import { confirmedInterviewNotionProperties, canceledInterviewNotionProperties, type Campus } from "./interview-notion-contract";
export type SyntheticNotionSync={campus:Campus;pageId:string;reservationId:string;status:"confirmed"|"canceled";startsAt:string;meetUrl:string|null;interviewerEmail:string;recipientEmail:string};
/** Only a configured synthetic clone can be written. Never edit placement owner, availability, notes, or application fields. */
export async function syncSyntheticNotionInterview(input:SyntheticNotionSync,transport:typeof fetch=fetch):Promise<void>{
  const cfg=previewNotionConfiguration();
  if(process.env.INTERVIEW_NOTION_WRITES_ENABLED!=="true")throw new PreviewNotionReadError("synthetic_notion_writes_disabled");
  const normalize=(id:string)=>id.replaceAll("-","").toLowerCase();
  if(!/^[a-f0-9-]{32,36}$/i.test(input.pageId)||!["BU","BC"].includes(input.campus)||!/^[0-9a-f-]{36}$/i.test(input.reservationId))throw new PreviewNotionReadError("invalid_notion_sync");
  const expected=input.campus==="BU"?cfg.buId:cfg.bcId;
  const headers={Authorization:"Bearer "+cfg.token,"Notion-Version":"2022-06-28","Content-Type":"application/json"};
  const url="https://api.notion.com/v1/pages/"+normalize(input.pageId);
  const response=await transport(url,{headers,cache:"no-store",signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw new PreviewNotionReadError("notion_sync_lookup_failed");
  const page=await response.json() as {id?:string;archived?:boolean;in_trash?:boolean;parent?:{database_id?:string};properties?:Record<string,{email?:string;rich_text?:Array<{plain_text?:string}>}>};
  if(normalize(page.id??"")!==normalize(input.pageId)||page.archived||page.in_trash||normalize(page.parent?.database_id??"")!==expected||(!page.properties?.Email?.email?.endsWith("@example.invalid")||page.properties.Email.email.trim().toLowerCase()!==input.recipientEmail.trim().toLowerCase()))throw new PreviewNotionReadError("notion_sync_identity_mismatch");
  // These fields must exist on the isolated clone. Never create options in a live pipeline.
  for(const field of ["Scheduling Reservation ID","Interviewed By","Google Meet URL","Interview Date","Interview Status"]){
    if(!page.properties[field])throw new PreviewNotionReadError("notion_sync_schema_incomplete");
  }
  const current=page.properties["Scheduling Reservation ID"].rich_text?.map((p)=>p.plain_text??"").join("")??"";
  if(current&&current!==input.reservationId)throw new PreviewNotionReadError("notion_sync_newer_booking_present");
  if(input.status==="confirmed"&&!/^https:\/\/meet\.google\.com\/[a-z0-9-]+$/.test(input.meetUrl??""))throw new PreviewNotionReadError("notion_sync_requires_meet");
  const properties=input.status==="confirmed" ? confirmedInterviewNotionProperties({campus:input.campus,utcStart:input.startsAt,reservationId:input.reservationId,interviewerEmail:input.interviewerEmail,meetUrl:input.meetUrl!}) : canceledInterviewNotionProperties(input.campus);
  const patched=await transport(url,{method:"PATCH",headers,body:JSON.stringify({properties}),cache:"no-store",signal:AbortSignal.timeout(8000)});
  if(!patched.ok)throw new PreviewNotionReadError(patched.status===429?"notion_sync_rate_limited":"notion_sync_patch_failed");
}
