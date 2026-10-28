import {NextRequest} from "next/server";
import {interviewAdminGuard,interviewPrivateReply} from "../../../../../lib/interview-admin-api";
import {staffFromRequest} from "../../../../../lib/interview-auth";
import {interviewDatabase} from "../../../../../lib/interview-db";
import {saveInterviewerSettings} from "../../../../../lib/interview-roster";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(request:NextRequest){
  const denied=interviewAdminGuard(request);if(denied)return denied;
  try{
    const roster=await interviewDatabase()`SELECT id,workspace_email,display_name,active,allowed_campuses,weekly_capacity_limit FROM interview.interviewer ORDER BY display_name LIMIT 200`;
    return interviewPrivateReply({ok:true,roster});
  }catch{return interviewPrivateReply({ok:false,error:"roster_unavailable"},503);}
}
export async function POST(request:NextRequest){
  const denied=interviewAdminGuard(request);if(denied)return denied;
  try{
    const raw=await request.text();if(raw.length>2000)return interviewPrivateReply({ok:false,error:"request_too_large"},413);
    return interviewPrivateReply({ok:true,...await saveInterviewerSettings(JSON.parse(raw),staffFromRequest(request)!.email)});
  }catch(error){
    const code=error instanceof Error?error.message:"";
    return interviewPrivateReply({ok:false,error:["invalid_interviewer_settings","interviewer_not_in_verified_allowlist"].includes(code)?code:"roster_update_unavailable"},code.startsWith("invalid_")?400:409);
  }
}
