import { bookedInterviewAccess } from "./interview-booked-link";
import { isApprovedInterviewTeam } from "./interview-teams";
import { createHash, randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { productionCanaryConfig, assertProductionCanaryIdentity } from "./interview-production-canary";
import { productionInterviewDatabase } from "./interview-production-db";
import { verifyLiveCanaryApplicant } from "./interview-production-notion";
import { checkProductionCanaryCalendars } from "./interview-production-calendar";
import { hasRequiredInterviewTeam, readInterviewTeams, lockInterviewTeamWeeks, teamForSlot, type InterviewParticipant } from "./interview-teams";
import { instantToEasternLocal, easternLocalToInstant, isNextDayOrLaterInEasternTime } from "./interview-timezone";
import { mondayForDate } from "./interview-availability";
import { postgresConflictCode } from "./interview-db";

import { productionRealEnabled, productionRealConfig, assertProductionBookingIdentity } from "./interview-production-launch";

// Production-real mode is a separate explicit release. Canary-only routes
// retain their original canary guards and cannot be widened by this adapter.
const productionServiceConfig = () => productionRealEnabled()
  ? productionRealConfig() : productionCanaryConfig();
const requireProductionIdentity = (...args: Parameters<typeof assertProductionCanaryIdentity>) =>
  productionRealEnabled()
    ? assertProductionBookingIdentity(args[0],args[1],args[2])
    : assertProductionCanaryIdentity(...args);


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
    startsAt: string, endsAt: string, campus: "BU" | "BC",
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
  if (!isNextDayOrLaterInEasternTime(date, new Date(now))) {
    throw new ProductionBookingError("same_day_booking_not_allowed", 409);
  }
  if (easternLocalToInstant(local.date, local.minute).getTime() !== date.getTime() ||
      (productionRealEnabled()
        ? date.getTime() > now + 40 * 86400000
        : mondayForDate(local.date) !== "2026-11-02")) {
    throw new ProductionBookingError(productionRealEnabled()
      ? "booking_outside_approved_horizon" : "canary_week_not_approved", 409);
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
  return reserveProductionSlot(input, deps);
}

export async function requestProductionCanaryReschedule(
  input: ProductionHoldInput & {reservationId: string}, deps: ProductionBookingDependencies = {},
) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.reservationId ?? "")) {
    throw new ProductionBookingError("invalid_reschedule_request", 400);
  }
  const hold = await reserveProductionSlot(input, deps, input.reservationId);
  return {id: hold.id, state: "pending", startsAt: hold.startsAt, endsAt: hold.endsAt};
}

/** A past, uncompleted reservation must not keep the one-active-booking lock.
 * Confirmed misses become no_show and keep their Calendar event. A hold that
 * never confirmed becomes expired. In-flight outbox work is left alone.
 */
async function releaseMissedReservations(tx: Sql, invitationId: string, now: number) {
  const rows = await tx<{
    id: string; status: string; ends_at: Date; attendance: string | null; calendar_event_id: string | null;
  }[]>`
    SELECT r.id, r.status, r.ends_at, r.calendar_event_id,
      (SELECT e.outcome FROM interview.audit_event e
        WHERE e.object_type='reservation' AND e.object_id=r.id::text
          AND e.action='record_attendance'
        ORDER BY e.id DESC LIMIT 1) AS attendance
    FROM interview.reservation r
    WHERE r.invitation_id=${invitationId}
      AND r.status NOT IN ('canceled','failed','expired')
    FOR UPDATE
  `;
  for (const row of rows) {
    const ended = row.ends_at.getTime() <= now;
    if (row.status === "completed" || row.attendance === "completed") {
      throw new ProductionBookingError("already_booked", 409);
    }
    if (row.status === "no_show") continue;
    const missedConfirmed = row.status === "confirmed" && ended;
    const abandonedHold = row.status === "calendar_pending" && ended;
    if (!missedConfirmed && !abandonedHold) {
      throw new ProductionBookingError("already_booked", 409);
    }
    const openReplacement = await tx<{ id: string }[]>`
      SELECT id FROM interview.reschedule_request
      WHERE reservation_id=${row.id} AND state IN ('pending','cancel_pending','reconcile_required')
      FOR UPDATE`;
    if (openReplacement.length) throw new ProductionBookingError("replacement_cleanup_required", 409);
    const jobs = await tx<{ state: string }[]>`
      SELECT state FROM interview.integration_outbox WHERE object_id=${row.id} FOR UPDATE`;
    if (jobs.some(job => job.state === "processing")) {
      throw new ProductionBookingError("booking_operation_in_progress", 409);
    }
    await tx`UPDATE interview.integration_outbox
      SET state='done', last_error_code='superseded_by_rebook', updated_at=now()
      WHERE object_id=${row.id} AND state IN ('queued','retry','reconcile_required')`;
    await tx`UPDATE interview.message SET state='suppressed'
      WHERE object_id=${row.id} AND kind='confirmation' AND state='queued'`;
    const next = row.status === "confirmed" ? "no_show" : "expired";
    await tx`UPDATE interview.reservation
      SET status=${next}, revision=revision+1, updated_at=now()
      WHERE id=${row.id}`;
    await tx`INSERT INTO interview.audit_event(actor_ref,action,object_type,object_id,outcome,metadata)
      VALUES('volunteer_self_service','release_missed_interview','reservation',${row.id},
        ${next}, ${JSON.stringify({ previousStatus: row.status })}::jsonb)`;
    if (next === "expired" && row.calendar_event_id) {
      await tx`INSERT INTO interview.integration_outbox(operation_key,provider,action,object_id)
        VALUES(${"interview-calendar:cancel:" + row.id},'google_calendar','cancel_event',${row.id})
        ON CONFLICT(operation_key) DO NOTHING`;
    }
  }
}

async function reserveProductionSlot(
  input: ProductionHoldInput, deps: ProductionBookingDependencies, originalId?: string,
): Promise<ProductionHold> {
  productionServiceConfig();
  const start = validRequest(input, deps.now);
  const verifyCalendars = deps.checkCalendars ?? ((participants, startsAt, endsAt, campus) =>
    checkProductionCanaryCalendars(participants, startsAt, endsAt, fetch, campus));
  const db = deps.database ?? productionInterviewDatabase();
  // An existing verified link remains usable even when the applicant opted out
  // of further invitation campaigns. The outreach queue still honors opt-outs.
  const tokenHash = createHash("sha256").update(input.invitationToken).digest("hex");
  const candidates = await db<Invite[]>`
    SELECT i.id, i.campus, i.notion_page_id, i.recipient_hmac, c.email
    FROM interview.invitation i
    JOIN interview.applicant_contact c ON c.invitation_id = i.id
    WHERE i.token_hash=${tokenHash} AND i.revoked_at IS NULL
      AND (i.expires_at>now() OR ${bookedInterviewAccess(db,originalId??null)})
      AND i.email_verified_at IS NOT NULL
       LIMIT 1
  `;
  const invite = candidates[0];
  if (!invite) throw new ProductionBookingError("invitation_unavailable", 403);
  try { requireProductionIdentity(invite.campus, invite.email, invite.notion_page_id); }
  catch { throw new ProductionBookingError("canary_identity_denied", 403); }
  const liveApplicant = deps.verifyApplicant ?? verifyLiveCanaryApplicant;
  await liveApplicant({campus:invite.campus,pageId:invite.notion_page_id,email:invite.email,
    ...(originalId ? {reservationId:originalId} : {})});

  const teams = await readInterviewTeams(db);
  const team = teamForSlot(teams,input.interviewerId,start.toISOString(),invite.campus);
  if (!team || !isApprovedInterviewTeam(team) ||
      !hasRequiredInterviewTeam(invite.campus,team.participants) ||
      team.participants.some(p=>!p.available || !p.email.endsWith("@campus2care.org"))) {
    throw new ProductionBookingError("founder_team_unavailable");
  }
  const end = new Date(start.getTime()+20*60000);
  await verifyCalendars(team.participants,start.toISOString(),end.toISOString(),invite.campus);

  try {
    return await db.begin(async tx => {
      const locked = await tx<Invite[]>`
        SELECT i.id, i.campus, i.notion_page_id, i.recipient_hmac, c.email
        FROM interview.invitation i
        JOIN interview.applicant_contact c ON c.invitation_id=i.id
        WHERE i.id=${invite.id} AND i.token_hash=${tokenHash}
          AND i.revoked_at IS NULL AND i.email_verified_at IS NOT NULL
          AND (i.expires_at>now() OR ${bookedInterviewAccess(tx,originalId??null)})
        FOR UPDATE OF i,c
      `;
      const current=locked[0];
      if (!current || current.campus!==invite.campus ||
          current.notion_page_id!==invite.notion_page_id ||
          current.email!==invite.email || current.recipient_hmac!==invite.recipient_hmac) {
        throw new ProductionBookingError("invitation_changed",409);
      }
      let originalKey: string | null = null;
      if (originalId) {
        const originals = await tx<{id:string;status:string;starts_at:Date;interviewer_id:string;calendar_operation_key:string|null}[]>`
          SELECT id,status,starts_at,interviewer_id,calendar_operation_key FROM interview.reservation
          WHERE id=${originalId} AND invitation_id=${current.id} FOR UPDATE`;
        const original = originals[0];
        if (!original || original.status !== "confirmed" || original.starts_at.getTime() <= (deps.now ?? Date.now())) {
          throw new ProductionBookingError("reschedule_requires_confirmed_booking",409);
        }
        if (original.interviewer_id === input.interviewerId && original.starts_at.getTime() === start.getTime()) {
          throw new ProductionBookingError("choose_different_slot",409);
        }
        const unsettled = await tx<{state:string}[]>`SELECT state FROM interview.integration_outbox
          WHERE object_id=${original.id} FOR UPDATE`;
        if (unsettled.some(job=>job.state!=="done")) throw new ProductionBookingError("booking_operation_in_progress",409);
        const replacements = await tx<{state:string}[]>`SELECT j.state FROM interview.integration_outbox j
          JOIN interview.reschedule_request x ON x.id=j.object_id WHERE x.reservation_id=${original.id} FOR UPDATE OF j`;
        if(replacements.some(job=>job.state!=="done"))throw new ProductionBookingError("replacement_cleanup_required",409);
        originalKey = original.calendar_operation_key ?? "interview-calendar:create:"+original.id;
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
          AND (approved_by='president@campus2care.org' OR
            (approved_by='ryan.daves@campus2care.org' AND campus='BC' AND EXISTS (
              SELECT 1 FROM interview.interviewer owner
              JOIN interview.schedule_participant participant ON participant.participant_id=owner.id
              WHERE participant.slot_id=interview.schedule_slot.id AND owner.workspace_email='ryan.daves@campus2care.org'
                AND (owner.id=interview.schedule_slot.lead_id OR (participant.role='shadow' AND owner.lead_interviewer_id=interview.schedule_slot.lead_id)))))
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
      const bookingWeek=mondayForDate(instantToEasternLocal(start).date);
      const counts=await tx<{total:number}[]>`
        SELECT count(*)::int AS total FROM (
          SELECT r.id FROM interview.reservation r
          WHERE r.interviewer_id=${input.interviewerId}
            AND r.status IN ('held','calendar_pending','confirmed','reschedule_pending','cancel_pending','reconcile_required','completed','no_show')
            AND r.id IS DISTINCT FROM ${originalId ?? null}::uuid
            AND (r.starts_at AT TIME ZONE 'America/New_York')::date
              BETWEEN ${bookingWeek}::date AND (${bookingWeek}::date+6)
          UNION
          SELECT x.id FROM interview.reschedule_request x
          WHERE x.interviewer_id=${input.interviewerId}
            AND x.state IN ('pending','cancel_pending','reconcile_required')
            AND x.reservation_id IS DISTINCT FROM ${originalId ?? null}::uuid
            AND (x.starts_at AT TIME ZONE 'America/New_York')::date
              BETWEEN ${bookingWeek}::date AND (${bookingWeek}::date+6)
        ) capacity_rows
      `;
      if((counts[0]?.total??0)>=lead.weekly_capacity_limit) {
        throw new ProductionBookingError("weekly_capacity_reached");
      }
      const id=randomUUID();
      if (!originalId) await releaseMissedReservations(tx, current.id, deps.now ?? Date.now());
      if (originalId && originalKey) {
        await tx`INSERT INTO interview.reschedule_request(id,reservation_id,interviewer_id,starts_at,ends_at,original_calendar_key)
          VALUES(${id},${originalId},${input.interviewerId},${start.toISOString()},${end.toISOString()},${originalKey})`;
        await tx`INSERT INTO interview.slot_claim(claim_key,interviewer_id,starts_at,blocks_until)
          VALUES(${"reschedule:"+id},${input.interviewerId},${start.toISOString()},${end.toISOString()})`;
        await tx`INSERT INTO interview.integration_outbox(operation_key,provider,action,object_id)
          VALUES(${"interview-reschedule:create:"+id},'google_calendar','reschedule_create',${id})`;
        return {id,status:"calendar_pending" as const,startsAt:start.toISOString(),endsAt:end.toISOString()};
      }
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
