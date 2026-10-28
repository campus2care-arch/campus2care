import { NextRequest } from "next/server";
import { interviewAdminGuard,interviewPrivateReply } from "../../../../../lib/interview-admin-api";
import { interviewDatabase } from "../../../../../lib/interview-db";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(request:NextRequest) {
  const denied=interviewAdminGuard(request);if(denied)return denied;
  try {
    const db=interviewDatabase();
    const [jobs,bookings,messages]=await Promise.all([
      db`SELECT id,provider,action,state,attempts,last_error_code FROM interview.integration_outbox WHERE state<>'done' ORDER BY created_at LIMIT 50`,
      db`SELECT id,status,starts_at,conflict_reason FROM interview.reservation WHERE status NOT IN ('canceled','failed','expired') ORDER BY starts_at LIMIT 50`,
      db`SELECT state,count(*)::int AS total FROM interview.message GROUP BY state`,
    ]);
    return interviewPrivateReply({ok:true,jobs,bookings,messages,workerEnabled:process.env.INTERVIEW_OUTBOX_WORKER_ENABLED==="true",gmailEnabled:process.env.INTERVIEW_SYNTHETIC_GMAIL_ENABLED==="true"});
  } catch {return interviewPrivateReply({ok:false,error:"operations_unavailable"},503);}
}
export async function POST(request:NextRequest) {
  const denied=interviewAdminGuard(request);if(denied)return denied;
  try {
    const raw=await request.text();if(raw.length>1000)return interviewPrivateReply({ok:false,error:"request_too_large"},413);
    const input=JSON.parse(raw);
    if(input.action!=="offboard" || !/^[0-9a-f-]{36}$/i.test(input.interviewerId??""))return interviewPrivateReply({ok:false,error:"invalid_request"},400);
    const affected=await interviewDatabase().begin(async(tx)=>{
      const roster=await tx`UPDATE interview.interviewer SET active=false,weekly_capacity_limit=0,updated_at=now() WHERE id=${input.interviewerId} AND workspace_email='bob@campus2care.org' RETURNING id`;
      if(!roster.length)throw new Error("synthetic_interviewer_required");
      const conflicts=await tx`UPDATE interview.reservation SET conflict_reason='interviewer_offboarded',revision=revision+1,updated_at=now() WHERE interviewer_id=${input.interviewerId} AND starts_at>now() AND status IN ('held','calendar_pending','confirmed','reschedule_pending','cancel_pending','reconcile_required') RETURNING id`;
      await tx`INSERT INTO interview.audit_event(actor_ref,action,object_type,object_id,outcome) VALUES('admin','offboard','interviewer',${input.interviewerId},'disabled_future_bookings')`;
      return conflicts.length;
    });
    return interviewPrivateReply({ok:true,appointmentsRequiringReassignment:affected});
  } catch {return interviewPrivateReply({ok:false,error:"offboarding_unavailable"},503);}
}
