import {createHash} from "node:crypto";
import type {Sql} from "postgres";
import {productionRealConfig} from "./interview-production-launch";
import {productionInterviewDatabase} from "./interview-production-db";
import {verifyLiveCanaryApplicant} from "./interview-production-notion";
import {hasRequiredInterviewTeam,readInterviewTeams,teamForSlot} from "./interview-teams";

export class LiveInterviewError extends Error {
  constructor(public code:string,public status=409){super(code);}
}
const uuid=(s:unknown)=>typeof s==="string"&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(s);
const secret=(s:unknown)=>typeof s==="string"&&/^[A-Za-z0-9_-]{32,256}$/.test(s);
type Invite={id:string;campus:"BU"|"BC";notion_page_id:string;email:string;
  email_verified_at:Date|null;opted_out_at:Date|null};
type Dependencies={db?:Sql;now?:Date;verify?:typeof verifyLiveCanaryApplicant};
async function invitation(db:Sql,token:string,unverified=false):Promise<Invite>{
  if(!secret(token))throw new LiveInterviewError("invalid_or_unverified_invitation",403);
  const digest=createHash("sha256").update(token).digest("hex");
  const rows=await db<Invite[]>`SELECT i.id,i.campus,i.notion_page_id,i.email_verified_at,
    c.email,c.opted_out_at FROM interview.invitation i
    JOIN interview.applicant_contact c ON c.invitation_id=i.id
    WHERE i.token_hash=${digest} AND i.revoked_at IS NULL AND i.expires_at>now()
    LIMIT 1`;
  const row=rows[0];
  if(!row||(!unverified&&!row.email_verified_at))
    throw new LiveInterviewError("invalid_or_unverified_invitation",403);
  if(!["BU","BC"].includes(row.campus)||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email))
    throw new LiveInterviewError("invalid_or_unverified_invitation",403);
  return row;
}
export async function readLiveInterviewStatus(token:string,deps:Dependencies={}){
  productionRealConfig();
  const db=deps.db??productionInterviewDatabase();
  const inv=await invitation(db,token);
  const rows=await db<{id:string;status:string;starts_at:Date;ends_at:Date;meet_url:string|null}[]>`
    SELECT r.id,r.status,r.starts_at,r.ends_at,r.meet_url FROM interview.reservation r
    WHERE r.invitation_id=${inv.id} AND r.campus=${inv.campus}
      AND r.notion_page_id=${inv.notion_page_id}
    ORDER BY r.created_at DESC LIMIT 1`;
  const row=rows[0];
  const reschedule=row?await db<{id:string;state:string;starts_at:Date}[]>`
    SELECT id,state,starts_at FROM interview.reschedule_request
    WHERE reservation_id=${row.id} AND state IN ('pending','cancel_pending','reconcile_required')
    ORDER BY created_at DESC LIMIT 1`:[];
  return {booking:row?{id:row.id,status:row.status,
    startsAt:row.starts_at.toISOString(),endsAt:row.ends_at.toISOString(),
    meetUrl:row.status==="confirmed"?row.meet_url:null}:null,
    reschedule:reschedule[0]?{id:reschedule[0].id,state:reschedule[0].state,
      startsAt:reschedule[0].starts_at.toISOString()}:null};
}
export async function readLiveInterviewSlots(token:string,reservationId?:string,deps:Dependencies={}){
  productionRealConfig();
  const db=deps.db??productionInterviewDatabase();
  const inv=await invitation(db,token);
  if(inv.opted_out_at)throw new LiveInterviewError("applicant_opted_out",403);
  if(reservationId&&!uuid(reservationId))throw new LiveInterviewError("invalid_reschedule_request",400);
  if(reservationId){
    const original=await db<{id:string}[]>`SELECT id FROM interview.reservation
      WHERE id=${reservationId} AND invitation_id=${inv.id} AND status='confirmed'
        AND starts_at>now() LIMIT 1`;
    if(!original.length)throw new LiveInterviewError("reschedule_requires_confirmed_booking");
  } else {
    const previous=await db<{id:string}[]>`SELECT id FROM interview.reservation
      WHERE recipient_hmac=(SELECT recipient_hmac FROM interview.invitation WHERE id=${inv.id})
        AND status NOT IN ('canceled','failed','expired') LIMIT 1`;
    if(previous.length)throw new LiveInterviewError("already_booked");
  }
  const verify=deps.verify??verifyLiveCanaryApplicant;
  await verify({campus:inv.campus,pageId:inv.notion_page_id,email:inv.email,
    ...(reservationId?{reservationId}:{})});
  const now=(deps.now??new Date()).toISOString();
  const rows=await db<{id:string;lead_id:string;starts_at:Date;display_name:string;
    weekly_capacity_limit:number}[]>`
    SELECT s.id,s.lead_id,s.starts_at,i.display_name,i.weekly_capacity_limit
    FROM interview.schedule_slot s JOIN interview.interviewer i ON i.id=s.lead_id
    WHERE s.campus=${inv.campus} AND s.approved_by='president@campus2care.org'
      AND s.approved_at IS NOT NULL AND i.active=true
      AND i.weekly_capacity_limit>0 AND s.starts_at>${now}::timestamptz + interval '30 minutes'
      AND s.starts_at<${now}::timestamptz + interval '40 days'
      AND ${inv.campus}=ANY(i.allowed_campuses)
      AND NOT EXISTS (
        SELECT 1 FROM interview.schedule_participant sp
        JOIN interview.slot_claim sc ON sc.interviewer_id=sp.participant_id
        WHERE sp.slot_id=s.id
        AND sc.starts_at<s.starts_at+interval '20 minutes'
        AND sc.blocks_until>s.starts_at
      )
    ORDER BY s.starts_at,i.display_name LIMIT 150`;
  const teams=await readInterviewTeams(db);
  const slots=[];
  for(const row of rows){
    const start=row.starts_at.toISOString();
    const team=teamForSlot(teams,row.lead_id,start,inv.campus);
    if(!team||team.id!==row.id||team.approvedBy!=="president@campus2care.org"||
        !hasRequiredInterviewTeam(inv.campus,team.participants)||team.participants.some(p=>!p.available))continue;
    const claims=await db<{total:number}[]>`SELECT count(*)::int AS total
      FROM interview.slot_claim WHERE interviewer_id=${row.lead_id}
        AND claim_key NOT LIKE '%:participant:%'
        AND date_trunc('week',starts_at AT TIME ZONE 'America/New_York') =
          date_trunc('week',${start}::timestamptz AT TIME ZONE 'America/New_York')`;
    // Actual reservation transaction independently enforces weekly capacity.
    if((claims[0]?.total??0)>=row.weekly_capacity_limit)continue;
    slots.push({interviewerId:row.lead_id,interviewerName:row.display_name,
      shadowNames:team.participants.filter(p=>p.role==="shadow").map(p=>p.name),
      startsAt:start,endsAt:new Date(row.starts_at.getTime()+20*60_000).toISOString(),
      timeZone:"America/New_York"});
    if(slots.length>=60)break;
  }
  return slots;
}
/** Opt-out affects outreach only. Existing confirmed reservations remain
 * cancellable and staff can still reach the applicant by direct reply.
 */
export async function optOutLiveInterview(token:string,deps:Dependencies={}){
  productionRealConfig();
  const db=deps.db??productionInterviewDatabase();
  const inv=await invitation(db,token,true);
  await db`UPDATE interview.applicant_contact SET opted_out_at=COALESCE(opted_out_at,now())
    WHERE invitation_id=${inv.id}`;
  return {optedOut:true};
}
