import {randomUUID} from "node:crypto";
import {previewNotionConfiguration} from "./interview-notion-preview";
import {syncSyntheticNotionInterview} from "./interview-notion-sync";
const testPages={BU:"407d6c55-a9de-8194-b14d-e7f70cc5ed22",BC:"407d6c55-a9de-815c-9363-d831bece88f2"} as const;
/** Fixed synthetic fixtures only; never accepts a caller-supplied Notion page. */
export async function verifySyntheticNotionPipelines(transport:typeof fetch=fetch){
  const cfg=previewNotionConfiguration();
  const read=async(page:string)=>{
    const response=await transport("https://api.notion.com/v1/pages/"+page,{headers:{Authorization:"Bearer "+cfg.token,"Notion-Version":"2022-06-28"},cache:"no-store",signal:AbortSignal.timeout(8000)});
    if(!response.ok)throw new Error("notion_verification_lookup_failed");
    return await response.json() as {properties:Record<string,unknown>};
  };
  const preserved=(page:{properties:Record<string,unknown>})=>JSON.stringify([page.properties["Executive Associate Owner"],page.properties.Availability,page.properties["Interview Notes"]]);
  const results=[];
  for(const campus of ["BU","BC"] as const){
    const pageId=testPages[campus],before=await read(pageId),reservationId=randomUUID();
    const input={campus,pageId,reservationId,startsAt:new Date(Date.now()+7*86400000).toISOString(),interviewerEmail:"bob@campus2care.org",recipientEmail:"scheduling-"+campus.toLowerCase()+"@example.invalid",meetUrl:"https://meet.google.com/abc-defg-hij"};
    let scheduled=false,cleaned=false,unchanged=false;
    try{
      await syncSyntheticNotionInterview({...input,status:"confirmed"},transport);
      const page=await read(pageId);
      const props=page.properties as Record<string,{select?:{name:string};url?:string;rich_text?:Array<{plain_text?:string}>}>;
      scheduled=props["Interview Status"]?.select?.name==="Scheduled"&&props["Google Meet URL"]?.url===input.meetUrl&&props["Scheduling Reservation ID"]?.rich_text?.map(x=>x.plain_text).join("")===reservationId;
      unchanged=preserved(page)===preserved(before);
    }finally{
      await syncSyntheticNotionInterview({...input,status:"canceled"},transport);
      const page=await read(pageId);
      const props=page.properties as Record<string,{select?:{name:string};date?:unknown;url?:unknown}>;
      cleaned=props["Interview Status"]?.select?.name==="Not Scheduled"&&props["Interview Date"]?.date===null&&props["Google Meet URL"]?.url===null;
      unchanged=unchanged&&preserved(page)===preserved(before);
    }
    results.push({campus,scheduled,cleaned,preserved:unchanged});
  }
  return results;
}
