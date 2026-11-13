import postgres,{type Sql} from "postgres";
import {requireProductionAudienceReview, type AudienceReviewFacts} from "./interview-production-applicant-review";
import {outreachHistoryLookbackHours} from "./interview-dispatch-policy";

/**
 * Read-only production snapshot. All SQL is static and selects HMACs rather
 * than recipient addresses. Manual outreach clearance is NEVER inferred from
 * an absence of messages in this database: older delegated Gmail may exist.
 */

/**
 * Open slots an applicant can book. Matches listing: an active lead with
 * capacity, a founder-approved or lead-published slot, and no shadower
 * required. Send approval is a separate founder manifest and is not decided here.
 */
export const bookableSlotCapacitySql =
  "SELECT s.campus,count(*)::int AS open FROM interview.schedule_slot s " +
  "JOIN interview.interviewer i ON i.id=s.lead_id " +
  "WHERE i.active AND i.weekly_capacity_limit>0 AND s.campus=ANY(i.allowed_campuses) " +
  "AND s.approved_at IS NOT NULL AND (" +
  "s.approved_by='president@campus2care.org' " +
  "OR lower(s.approved_by)=lower(i.workspace_email) " +
  "OR (s.approved_by='ryan.daves@campus2care.org' AND s.campus='BC' AND EXISTS (" +
  "SELECT 1 FROM interview.interviewer owner " +
  "JOIN interview.schedule_participant participant ON participant.participant_id=owner.id " +
  "WHERE participant.slot_id=s.id AND lower(owner.workspace_email)='ryan.daves@campus2care.org' " +
  "AND participant.role='shadow' AND owner.lead_interviewer_id=s.lead_id))) " +
  "AND s.starts_at>now()+interval '30 minutes' AND s.starts_at<now()+interval '40 days' " +
  "AND (s.starts_at AT TIME ZONE 'America/New_York')::date>(now() AT TIME ZONE 'America/New_York')::date " +
  "AND NOT EXISTS (" +
  "SELECT 1 FROM interview.schedule_participant sp " +
  "JOIN interview.slot_claim sc ON sc.interviewer_id=sp.participant_id " +
  "WHERE sp.slot_id=s.id AND sc.starts_at<s.starts_at+interval '20 minutes' AND sc.blocks_until>s.starts_at " +
  "AND (" +
  "EXISTS (SELECT 1 FROM interview.reservation active " +
  "WHERE active.status IN ('held','calendar_pending','confirmed','reschedule_pending','cancel_pending','reconcile_required') " +
  "AND (sc.claim_key='reservation:'||active.id::text OR sc.claim_key LIKE 'reservation:'||active.id::text||':participant:%')) " +
  "OR EXISTS (SELECT 1 FROM interview.reschedule_request replacement " +
  "WHERE replacement.state IN ('pending','cancel_pending','reconcile_required') " +
  "AND (sc.claim_key='reschedule:'||replacement.id::text " +
  "OR sc.claim_key LIKE 'reschedule:'||replacement.id::text||':participant:%' " +
  "OR sc.claim_key='retired:'||replacement.id::text " +
  "OR sc.claim_key LIKE 'retired:'||replacement.id::text||':participant:%')))) " +
  "GROUP BY s.campus";

let audienceClient: Sql | undefined;
/** Independent read-only review connection. Production booking flags stay OFF. */
export function productionAudienceReviewDatabase(): Sql {
  requireProductionAudienceReview();
  const raw=process.env.INTERVIEW_DATABASE_URL??"";
  const expected=process.env.INTERVIEW_DATABASE_HOST??"";
  let parsed: URL;
  try {parsed=new URL(raw);} catch {throw Error("audience_database_invalid");}
  if (!["postgres:","postgresql:"].includes(parsed.protocol) ||
      parsed.hostname!==expected || !expected.endsWith(".neon.tech") ||
      !parsed.username || !parsed.password || parsed.pathname.length<2 ||
      parsed.hash || parsed.searchParams.get("sslmode")==="disable")
    throw Error("audience_database_invalid");
  audienceClient??=postgres(raw,{max:1,connect_timeout:8,idle_timeout:10,
    ssl:"require",prepare:false,onnotice:()=>undefined,
    connection:{application_name:"campus2care-interview-audience-review"}});
  return audienceClient;
}

export async function loadProductionAudienceFacts(db: Sql): Promise<AudienceReviewFacts> {
  requireProductionAudienceReview();
  const [suppressions, reservations, completed, optouts, attempts, capacities, outstanding] = await Promise.all([
    db.unsafe<{recipient_hmac:string}[]>(
      "SELECT recipient_hmac FROM interview.recipient_suppression"),
    db.unsafe<{recipient_hmac:string}[]>(
      "SELECT DISTINCT recipient_hmac FROM interview.reservation WHERE status IN ('held','calendar_pending','confirmed','reschedule_pending','cancel_pending','reconcile_required')"),
    db.unsafe<{recipient_hmac:string}[]>(
      "SELECT DISTINCT recipient_hmac FROM interview.reservation WHERE status='completed'"),
    db.unsafe<{recipient_hmac:string}[]>(
      "SELECT DISTINCT i.recipient_hmac FROM interview.invitation i JOIN interview.applicant_contact c ON c.invitation_id=i.id WHERE c.opted_out_at IS NOT NULL"),
    db.unsafe<{recipient_hmac:string;state:string;sent_at:Date|null;created_at:Date}[]>(
      "SELECT recipient_hmac,state,sent_at,created_at FROM interview.outreach_attempt WHERE created_at>now()-make_interval(hours=>$1) OR sent_at>now()-make_interval(hours=>$1) OR state IN ('queued','sending','reconcile_required')",
      [outreachHistoryLookbackHours()]),
    db.unsafe<{campus:"BU"|"BC";open:number}[]>(bookableSlotCapacitySql),
    // Unexpired invitations not yet booked will consume those slots too.
    db.unsafe<{campus:"BU"|"BC";outstanding:number}[]>(
      "SELECT i.campus,count(DISTINCT i.recipient_hmac)::int AS outstanding FROM interview.invitation i WHERE i.revoked_at IS NULL AND i.expires_at>now() AND i.notion_page_id NOT LIKE 'synthetic-%' AND NOT EXISTS (SELECT 1 FROM interview.reservation r WHERE r.recipient_hmac=i.recipient_hmac AND r.status NOT IN ('canceled','expired','failed')) GROUP BY i.campus"),
  ]);
  const open=(campus:"BU"|"BC")=>capacities.find(x=>x.campus===campus)?.open??0;
  const pending=(campus:"BU"|"BC")=>outstanding.find(x=>x.campus===campus)?.outstanding??0;
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
      BU:open("BU")>0,
      BC:open("BC")>0,
    },
    remainingCapacityByCampus:{
      BU:Math.max(0,open("BU")-pending("BU")),
      BC:Math.max(0,open("BC")-pending("BC")),
    },
    // Hold every applicant until a separate founder-approved review reconciles
    // historic manual outreach; never auto-clear from a database SELECT.
    manuallyClearedHmacs:new Set<string>(),
  };
}
