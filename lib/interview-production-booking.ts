import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { productionCanaryConfig, assertProductionCanaryIdentity } from "./interview-production-canary";
import { productionInterviewDatabase } from "./interview-production-db";
import { verifyLiveCanaryApplicant } from "./interview-production-notion";
import { readInterviewTeams, lockInterviewTeamWeeks, teamForSlot, type InterviewParticipant } from "./interview-teams";
import { instantToEasternLocal, easternLocalToInstant } from "./interview-timezone";
import { mondayForDate } from "./interview-availability";
import { postgresConflictCode } from "./interview-db";

/**
 * Canary-only first-phase booking. The provider worker is deliberately
 * required by the production gate but not implemented in this module.
 * A live route must not call this until the independent provider adapter
 * is deployed, authorized, tested and reports readiness.
 */
export type ProductionHoldInput = {
  invitationToken: string;
  interviewerId: string;
  startsAt: string;
};
export type ProductionHold = {
  id: string; status: "calendar_pending"; startsAt: string; endsAt: string;
};
export type ProductionBookingDependencies = {
  database?: Sql;
  now?: number;
  verifyApplicant?: typeof verifyLiveCanaryApplicant;
  checkCalendars?: (
    participants: InterviewParticipant[],
    startsAt: string, endsAt: string,
  ) => Promise<void>;
};
export class ProductionBookingError extends Error {
  constructor(public readonly code: string, public readonly status = 409) {
    super(code);
    this.name = "ProductionBookingError";
  }
}
function validRequest(input: ProductionHoldInput, now = Date.now()): Date {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(input?.invitationToken ?? "") ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input?.interviewerId ?? "") ||
      typeof input?.startsAt !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.startsAt)) {
    throw new ProductionBookingError("invalid_booking_request", 400);
  }
  const date = new Date(input.startsAt);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== input.startsAt ||
      date.getTime() < now + 30 * 60000) {
    throw new ProductionBookingError("invalid_booking_time", 400);
  }
  const local = instantToEasternLocal(date);
  if (mondayForDate(local.date) !== "2026-11-02" ||
      easternLocalToInstant(local.date, local.minute).getTime() !== date.getTime()) {
    throw new ProductionBookingError("canary_week_not_approved", 409);
  }
  return date;
}
type Invite = {
  id: string; campus: "BU" | "BC"; notion_page_id: string;
  recipient_hmac: string; email: string;
};
export async function createProductionCanaryHold(
  input: ProductionHoldInput, deps: ProductionBookingDependencies = {},
): Promise<ProductionHold> {
  productionCanaryConfig();
  const start = validRequest(input, deps.now);
  if (!deps.checkCalendars) throw new ProductionBookingError("production_calendar_check_unavailable", 503);
  const db = deps.database ?? productionInterviewDatabase();
  const tokenHash = createHash("sha256").update(input.invitationToken).digest("hex");
  const candidates = await db<Invite[]>`
    SELECT i.id, i.campus, i.notion_page_id, i.recipient_hmac, c.email
    FROM interview.invitation i
    JOIN interview.applicant_contact c ON c.invitation_id = i.id
    WHERE i.token_hash=${tokenHash} AND i.revoked_at IS NULL
      AND i.expires_at > now() AND i.email_verified_at IS NOT NULL
      AND c.opted_out_at IS NULL LIMIT 1
  `;
  const invite = candidates[0];
  if (!invite) throw new ProductionBookingError("invitation_unavailable", 403);
  try { assertProductionCanaryIdentity(invite.campus, invite.email, invite.notion_page_id); }
  catch { throw new ProductionBookingError("canary_identity_denied", 403); }
  const liveApplicant = deps.verifyApplicant ?? verifyLiveCanaryApplicant;
  await liveApplicant({campus:invite.campus,pageId:invite.notion_page_id,email:invite.email});

  const teams = await readInterviewTeams(db);
  const team = teamForSlot(teams,input.interviewerId,start.toISOString(),invite.campus);
  if (!team || team.approvedBy !== "president@campus2care.org" ||
      team.participants.length < 2 ||
      team.participants.some(p=>!p.available || !p.email.endsWith("@campus2care.org")) ||
      team.participants.filter(p=>p.role==="lead").length !== 1) {
    throw new ProductionBookingError("founder_team_unavailable");
  }
  const end = new Date(start.getTime()+20*60000);
  await deps.checkCalendars(team.participants,start.toISOString(),end.toISOString());

  try {
    return await db.begin(async tx => {
      const locked = await tx<Invite[]>`
        SELECT i.id, i.campus, i.notion_page_id, i.recipient_hmac, c.email
        FROM interview.invitation i
        JOIN interview.applicant_contact c ON c.invitation_id=i.id
        WHERE i.id=${invite.id} AND i.token_hash=${tokenHash}
          AND i.revoked_at IS NULL AND i.email_verified_at IS NOT NULL
          AND i.expires_at>now() AND c.opted_out_at IS NULL
        FOR UPDATE OF i,c
      `;
      const current=locked[0];
      if (!current || current.campus!==invite.campus ||
          current.notion_page_id!==invite.notion_page_id ||
          current.email!==invite.email || current.recipient_hmac!==invite.recipient_hmac) {
        throw new ProductionBookingError("invitation_changed",409);
      }
      const leads=await tx<{id:string;active:boolean;allowed_campuses:string[];weekly_capacity_limit:number;workspace_email:string}[]>`
        SELECT id,active,allowed_campuses,weekly_capacity_limit,workspace_email
        FROM interview.interviewer WHERE id=${input.interviewerId} FOR UPDATE
      `;
      const lead=leads[0];
      if(!lead?.active || lead.workspace_email === "bob@campus2care.org" ||
        !lead.allowed_campuses.includes(invite.campus) || lead.weekly_capacity_limit<1) {
        throw new ProductionBookingError("interviewer_unavailable");
      }
      const slots=await tx<{id:string}[]>`
        SELECT id FROM interview.schedule_slot
        WHERE lead_id=${input.interviewerId} AND campus=${invite.campus}
          AND starts_at=${start.toISOString()}::timestamptz
          AND approved_by='president@campus2care.org'
        FOR SHARE
      `;
      if(slots.length!==1)throw new ProductionBookingError("founder_slot_not_approved");
      await lockInterviewTeamWeeks(tx,input.interviewerId,start.toISOString());
      const verifiedTeam=teamForSlot(await readInterviewTeams(tx),
        input.interviewerId,start.toISOString(),invite.campus);
      if(!verifiedTeam || verifiedTeam.revision!==team.revision ||
          verifiedTeam.participants.length!==team.participants.length ||
          verifiedTeam.participants.some(p=>!p.available ||
            !team.participants.some(old=>old.id===p.id && old.role===p.role))) {
        throw new ProductionBookingError("interview_team_changed");
      }
      const counts=await tx<{total:number}[]>`
        SELECT count(*)::int AS total FROM interview.reservation
        WHERE interviewer_id=${input.interviewerId} AND
          (starts_at AT TIME ZONE 'America/New_York')::date
            BETWEEN date '2026-11-02' AND date '2026-11-08'
          AND status IN ('held','calendar_pending','confirmed','reschedule_pending','cancel_pending','reconcile_required')
      `;
      if((counts[0]?.total??0)>=lead.weekly_capacity_limit) {
        throw new ProductionBookingError("weekly_capacity_reached");
      }
      const id=randomUUID();
      await tx`
        INSERT INTO interview.reservation
          (id,invitation_id,campus,notion_page_id,recipient_hmac,interviewer_id,
           starts_at,ends_at,blocks_until,status)
        VALUES
          (${id},${current.id},${current.campus},${current.notion_page_id},
           ${current.recipient_hmac},${input.interviewerId},${start.toISOString()},
           ${end.toISOString()},${end.toISOString()},'calendar_pending')
      `;
      // The database trigger also reserves the approved shadowers' times.
      await tx`INSERT INTO interview.integration_outbox
        (operation_key,provider,action,object_id)
        VALUES (${"interview-calendar:create:"+id},'google_calendar','create_event',${id})`;
      return {id,status:"calendar_pending" as const,startsAt:start.toISOString(),endsAt:end.toISOString()};
    });
  } catch(error) {
    if(error instanceof ProductionBookingError)throw error;
    const conflict=postgresConflictCode(error);
    if(conflict)throw new ProductionBookingError(conflict,409);
    throw error;
  }
}
