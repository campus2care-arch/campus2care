import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { interviewBaseOrigin } from "../../../../../lib/interview-auth";
import { interviewPrivateReply } from "../../../../../lib/interview-admin-api";
import { interviewDatabase, requireInterviewStagingBooking } from "../../../../../lib/interview-db";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request:NextRequest) {
  try {
    requireInterviewStagingBooking();
    if (request.headers.get("origin") !== interviewBaseOrigin(request) || !request.headers.get("content-type")?.startsWith("application/json")) return interviewPrivateReply({ok:false,error:"invalid_request_origin"},403);
    const raw=await request.text(); if(raw.length>1000) return interviewPrivateReply({ok:false,error:"request_too_large"},413);
    const input=JSON.parse(raw);
    if(!/^[A-Za-z0-9_-]{32,256}$/.test(input.invitationToken ?? "")) return interviewPrivateReply({ok:false,error:"invalid_invitation"},403);
    const hash=createHash("sha256").update(input.invitationToken).digest("hex");
    const rows=await interviewDatabase()<{id:string;status:string;starts_at:Date;ends_at:Date;meet_url:string|null}[]>`
      SELECT r.id,r.status,r.starts_at,r.ends_at,r.meet_url FROM interview.reservation r JOIN interview.invitation i ON i.id=r.invitation_id
      WHERE i.token_hash=${hash} AND i.revoked_at IS NULL AND i.expires_at>now() AND i.email_verified_at IS NOT NULL
        AND r.notion_page_id LIKE 'synthetic-%' ORDER BY r.created_at DESC LIMIT 1`;
    const row=rows[0];
    return interviewPrivateReply({ok:true,booking:row ? {id:row.id,status:row.status,startsAt:row.starts_at.toISOString(),endsAt:row.ends_at.toISOString(),meetUrl:row.status==="confirmed"?row.meet_url:null}:null});
  } catch {return interviewPrivateReply({ok:false,error:"booking_status_unavailable"},503);}
}
