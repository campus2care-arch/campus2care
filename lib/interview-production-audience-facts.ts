import type {Sql} from "postgres";
import {requireProductionAudienceReview, type AudienceReviewFacts} from "./interview-production-applicant-review";

/**
 * Read-only production snapshot. All SQL is static and selects HMACs rather
 * than recipient addresses. Manual outreach clearance is NEVER inferred from
 * an absence of messages in this database: older delegated Gmail may exist.
 */
export async function loadProductionAudienceFacts(db: Sql): Promise<AudienceReviewFacts> {
  requireProductionAudienceReview();
  const [suppressions, reservations, completed, optouts, attempts, capacities] = await Promise.all([
    db.unsafe<{recipient_hmac:string}[]>(
      "SELECT recipient_hmac FROM interview.recipient_suppression"),
    db.unsafe<{recipient_hmac:string}[]>(
      "SELECT DISTINCT recipient_hmac FROM interview.reservation WHERE status IN ('held','calendar_pending','confirmed','reschedule_pending','cancel_pending','reconcile_required')"),
    db.unsafe<{recipient_hmac:string}[]>(
      "SELECT DISTINCT recipient_hmac FROM interview.reservation WHERE status='completed'"),
    db.unsafe<{recipient_hmac:string}[]>(
      "SELECT DISTINCT i.recipient_hmac FROM interview.invitation i JOIN interview.applicant_contact c ON c.invitation_id=i.id WHERE c.opted_out_at IS NOT NULL"),
    db.unsafe<{recipient_hmac:string;state:string;sent_at:Date|null;created_at:Date}[]>(
      "SELECT recipient_hmac,state,sent_at,created_at FROM interview.outreach_attempt WHERE created_at>now()-interval '7 days' OR sent_at>now()-interval '7 days' OR state IN ('queued','sending','reconcile_required')"),
    db.unsafe<{campus:"BU"|"BC"}[]>(
      "SELECT DISTINCT s.campus FROM interview.schedule_slot s JOIN interview.interviewer i ON i.id=s.lead_id WHERE s.approved_by='president@campus2care.org' AND i.active AND s.campus=ANY(i.allowed_campuses) AND i.weekly_capacity_limit>0 AND s.starts_at>now()+interval '30 minutes' AND s.starts_at<now()+interval '14 days' AND NOT EXISTS (SELECT 1 FROM interview.slot_claim c WHERE c.interviewer_id=i.id AND c.starts_at=s.starts_at)"),
  ]);
  const historyByHmac=new Map<string,{state:string;sentAt:string|null;createdAt:string}[]>();
  for (const row of attempts) {
    const list=historyByHmac.get(row.recipient_hmac)??[];
    list.push({state:row.state,sentAt:row.sent_at?.toISOString()??null,
      createdAt:row.created_at.toISOString()});
    historyByHmac.set(row.recipient_hmac,list);
  }
  return {
    suppressedHmacs:new Set(suppressions.map(x=>x.recipient_hmac)),
    reservedHmacs:new Set(reservations.map(x=>x.recipient_hmac)),
    completedHmacs:new Set(completed.map(x=>x.recipient_hmac)),
    optedOutHmacs:new Set(optouts.map(x=>x.recipient_hmac)),
    historyByHmac, capacityByCampus:{
      BU:capacities.some(x=>x.campus==="BU"),
      BC:capacities.some(x=>x.campus==="BC"),
    },
    // Hold every applicant until a separate founder-approved review reconciles
    // historic manual outreach; never auto-clear from a database SELECT.
    manuallyClearedHmacs:new Set<string>(),
  };
}
