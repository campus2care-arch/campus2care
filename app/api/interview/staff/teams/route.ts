import { NextRequest, NextResponse } from "next/server";
import { staffFromRequest } from "../../../../../lib/interview-auth";
import { interviewDatabase } from "../../../../../lib/interview-db";
import { readInterviewTeams } from "../../../../../lib/interview-teams";
import { instantToEasternLocal } from "../../../../../lib/interview-timezone";
import { mondayForDate } from "../../../../../lib/interview-availability";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(req: NextRequest) {
  const staff=staffFromRequest(req);
  if(!staff)return NextResponse.json({ok:false,error:"login_required"},{status:401});
  try {
    const week=req.nextUrl.searchParams.get("week");
    const teams=(await readInterviewTeams(interviewDatabase())).filter(team =>
      mondayForDate(instantToEasternLocal(new Date(team.startsAt)).date)===week &&
      (staff.role==="admin"||team.participants.some(p=>p.email===staff.email)));
    return NextResponse.json({ok:true,teams:teams.map(team=>({campus:team.campus,leadId:team.leadId,startsAt:team.startsAt,
      participants:team.participants.map(p=>({name:p.name,role:p.role,available:p.available}))}))},{headers:{"Cache-Control":"no-store"}});
  } catch {return NextResponse.json({ok:false,error:"team_schedule_unavailable"},{status:503});}
}
