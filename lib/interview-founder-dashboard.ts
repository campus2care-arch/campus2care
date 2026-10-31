import { createHmac } from "node:crypto";
import type { Sql } from "postgres";
import {
  scanProductionApplicantPipelines, reviewProductionApplicantAudience,
  type ProductionPipelineApplicant, type AudienceReviewFacts,
} from "./interview-production-applicant-review";
import { loadProductionAudienceFacts, productionAudienceReviewDatabase } from "./interview-production-audience-facts";

export type Campus = "BU" | "BC";
export type ApplicantRow = {
  key: string; campus: Campus; pageId: string; recipientHmac: string;
  name: string; email: string; eaOwner: string | null;
  interviewStatus: string | null; interviewDate: string | null;
  invitationsSent: number; lastInvitationAt: string | null;
  booking: "none" | "active" | "completed"; decision: string; nextAction: string;
  /** Can go into a founder-approved batch (frequency-limited needs an exception). */
  invitable: boolean; frequencyLimited: boolean;
};
export type DashboardSummary = {
  needingInterview: number; invitationsSent: number; scheduled: number; completed: number;
  awaitingResponse: number; openSlots: number; remainingCapacity: number;
};
export type Mismatch = { key: string; name: string; campus: Campus; issue: string };

const NEXT_ACTION: Record<string, string> = {
  manual_outreach_not_reconciled: "Ready to invite (confirm past emails)",
  spacing_48_hours: "Recently contacted: invite needs founder exception",
  rolling_week_limit: "Weekly limit reached: invite needs founder exception",
  no_confirmed_capacity: "Waiting for interview slots",
  unresolved_prior_message: "Previous email still sending or needs review",
  prior_booking_or_interview: "Booked or interviewed",
  interview_already_processed: "Interview recorded in Notion",
  suppressed_or_opted_out: "Opted out: do not contact",
  applicant_inactive: "Paused or withdrawn",
  duplicate_across_pipelines: "Duplicate record: fix in Notion",
  missing_or_invalid_email: "Fix email in Notion",
  not_approved_to_invite: "Not at interview stage",
  workflow_status_not_eligible: "Not at interview stage",
  archived: "Archived",
};

/** Pure: combine live Notion records, the eligibility review and Neon history. */
export function buildFounderDashboard(input: {
  applicants: ProductionPipelineApplicant[]; facts: AudienceReviewFacts; authSecret: string; now: Date;
  sent: Map<string, { count: number; last: string | null }>;
  bookings: Map<string, "active" | "completed">;
  openSlots: Record<Campus, number>;
}) {
  const review = reviewProductionApplicantAudience({ applicants: input.applicants, facts: input.facts,
    authSecret: input.authSecret, now: input.now });
  const decisions = new Map(review.entries.map((e) => [e.campus + ":" + e.pageId, e]));
  const rows: ApplicantRow[] = [];
  const mismatches: Mismatch[] = [];
  for (const a of input.applicants) {
    const pageId = a.pageId.replaceAll("-", "").toLowerCase();
    const key = a.campus + ":" + pageId;
    const entry = decisions.get(key);
    const hmac = entry?.recipientHmac ??
      createHmac("sha256", input.authSecret).update("recipient:" + a.email.trim().toLowerCase()).digest("hex");
    const decision = entry?.decision ?? "archived";
    const sent = input.sent.get(hmac);
    const booking = input.bookings.get(hmac) ?? "none";
    const frequencyLimited = decision === "spacing_48_hours" || decision === "rolling_week_limit";
    rows.push({ key, campus: a.campus, pageId, recipientHmac: hmac, name: a.name || "(no name)", email: a.email,
      eaOwner: a.eaOwner ?? null, interviewStatus: a.interviewStatus, interviewDate: a.interviewDate ?? null,
      invitationsSent: sent?.count ?? 0, lastInvitationAt: sent?.last ?? null, booking, decision,
      nextAction: NEXT_ACTION[decision] ?? decision.replaceAll("_", " "),
      invitable: decision === "manual_outreach_not_reconciled" || frequencyLimited, frequencyLimited });
    // Reconcile Neon bookings against what Notion says.
    if (booking === "active" && a.interviewStatus !== "Scheduled")
      mismatches.push({ key, name: a.name ?? "", campus: a.campus, issue: "Booked in the system but Notion says " + (a.interviewStatus ?? "blank") });
    if (a.interviewStatus === "Scheduled" && booking === "none" && !a.interviewDatePresent)
      mismatches.push({ key, name: a.name ?? "", campus: a.campus, issue: "Notion says Scheduled but there's no interview date or booking" });
    if (booking === "completed" && a.interviewStatus !== "Completed")
      mismatches.push({ key, name: a.name ?? "", campus: a.campus, issue: "Interview completed but Notion says " + (a.interviewStatus ?? "blank") });
  }
  return { rows, mismatches };
}

export function summarize(rows: ApplicantRow[], campus: Campus | "ALL", openSlots: Record<Campus, number>,
  remaining: Record<Campus, number>): DashboardSummary {
  const scope = rows.filter((r) => campus === "ALL" || r.campus === campus);
  const campuses: Campus[] = campus === "ALL" ? ["BU", "BC"] : [campus];
  const live = scope.filter((r) => !["archived", "applicant_inactive", "suppressed_or_opted_out"].includes(r.decision));
  return {
    needingInterview: live.filter((r) => r.interviewStatus === "Not Scheduled" && r.booking === "none" &&
      !["not_approved_to_invite", "workflow_status_not_eligible", "interview_already_processed"].includes(r.decision)).length,
    invitationsSent: scope.reduce((t, r) => t + r.invitationsSent, 0),
    scheduled: scope.filter((r) => r.booking === "active" || r.interviewStatus === "Scheduled").length,
    completed: scope.filter((r) => r.booking === "completed" || r.interviewStatus === "Completed").length,
    awaitingResponse: live.filter((r) => r.invitationsSent > 0 && r.booking === "none" &&
      r.interviewStatus === "Not Scheduled").length,
    openSlots: campuses.reduce((t, c) => t + openSlots[c], 0),
    remainingCapacity: campuses.reduce((t, c) => t + remaining[c], 0),
  };
}

/** Production read: live Notion pipelines plus Neon booking and outreach records. */
export async function loadFounderDashboard(db: Sql = productionAudienceReviewDatabase()) {
  const [applicants, facts, sentRows, bookingRows, slotRows] = await Promise.all([
    scanProductionApplicantPipelines(),
    loadProductionAudienceFacts(db),
    db.unsafe<{ recipient_hmac: string; count: number; last: Date | null }[]>(
      "SELECT recipient_hmac,count(*) FILTER (WHERE state='sent')::int AS count,max(sent_at) AS last " +
      "FROM interview.outreach_attempt GROUP BY recipient_hmac"),
    db.unsafe<{ recipient_hmac: string; state: "active" | "completed" }[]>(
      "SELECT recipient_hmac,CASE WHEN bool_or(status='completed') THEN 'completed' ELSE 'active' END AS state " +
      "FROM interview.reservation WHERE status NOT IN ('canceled','expired','failed') GROUP BY recipient_hmac"),
    // Bookable slots: active lead, at least one shadower, not booked (any future date).
    db.unsafe<{ campus: Campus; open: number }[]>(
      "SELECT s.campus,count(*)::int AS open FROM interview.schedule_slot s JOIN interview.interviewer i ON i.id=s.lead_id " +
      "WHERE s.approved_by IS NOT NULL AND i.active AND i.weekly_capacity_limit>0 AND s.starts_at>now()+interval '30 minutes' " +
      "AND EXISTS (SELECT 1 FROM interview.schedule_participant p WHERE p.slot_id=s.id AND p.role='shadow') " +
      "AND NOT EXISTS (SELECT 1 FROM interview.reservation r WHERE r.interviewer_id=s.lead_id AND r.starts_at=s.starts_at " +
      "AND r.status NOT IN ('canceled','expired','failed')) GROUP BY s.campus"),
  ]);
  const openSlots: Record<Campus, number> = { BU: 0, BC: 0 };
  for (const r of slotRows) openSlots[r.campus] = r.open;
  const built = buildFounderDashboard({
    applicants, facts, authSecret: process.env.INTERVIEW_AUTH_SECRET ?? "", now: new Date(),
    sent: new Map(sentRows.map((r) => [r.recipient_hmac, { count: r.count, last: r.last?.toISOString() ?? null }])),
    bookings: new Map(bookingRows.map((r) => [r.recipient_hmac, r.state])),
    openSlots,
  });
  return { ...built, openSlots, remainingCapacity: facts.remainingCapacityByCampus ?? { BU: 0, BC: 0 } };
}
