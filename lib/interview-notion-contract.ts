/**
 * Verified against the existing BU and BC live Notion data-source schemas
 * on October 28, 2026. Pure mapping only: NO API calls or writes.
 *
 * The production databases are never preview write targets. The existing
 * website application router owns intake; this module must not change it.
 */
export type Campus = "BU" | "BC";

const CAMPUS_DATABASES: Record<Campus, string> = {
  BU: "03192649741442fe86acdddcc7320798",
  BC: "bc8eaec9a5d449cd87426e8613299a93",
};

function normalizedId(id: string): string {
  if (!/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(id)) {
    throw new Error("invalid_notion_id");
  }
  return id.replaceAll("-", "").toLowerCase();
}

export function campusPipelineId(campus: Campus): string {
  if (campus !== "BU" && campus !== "BC") throw new Error("invalid_campus");
  return CAMPUS_DATABASES[campus];
}

/** Never assume a page ID belongs to the campus claimed by a bearer token. */
export function assertCampusPipelineParent(campus: Campus, parentDatabaseId: string): void {
  if (normalizedId(parentDatabaseId) !== campusPipelineId(campus)) {
    throw new Error("interview_applicant_campus_mismatch");
  }
}

export type ApplicantInterviewState = {
  email: string;
  stage: string | null;
  nextStep: string | null;
  interviewStatus: string | null;
  workflowStatus: string | null;
};

export type EligibilityResult = { eligible: boolean; reason: string };

/**
 * A strict, fail-closed first-invitation gate. It does not replace an
 * authorized Notion read or a human decision to invite.
 */
export function evaluateInitialInterviewEligibility(
  campus: Campus, state: ApplicantInterviewState,
): EligibilityResult {
  campusPipelineId(campus);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.email.trim())) {
    return { eligible: false, reason: "missing_or_invalid_email" };
  }
  if (state.workflowStatus === "Paused" ||
      state.workflowStatus === "Withdrawn / Not Proceeding") {
    return { eligible: false, reason: "applicant_inactive" };
  }
  if (state.interviewStatus !== "Not Scheduled") {
    return { eligible: false, reason: "interview_already_processed" };
  }
  if (state.stage !== "Needs Interview" || state.nextStep !== "Schedule interview") {
    return { eligible: false, reason: "not_approved_to_invite" };
  }
  const permitted = campus === "BU"
    ? ["Application Received", "Interview Needed"]
    : ["Application Received"];
  if (!state.workflowStatus || !permitted.includes(state.workflowStatus)) {
    return { eligible: false, reason: "workflow_status_not_eligible" };
  }
  return { eligible: true, reason: "eligible_for_reviewed_invitation" };
}

export function scheduledInterviewNotionPatch(campus: Campus, utcStart: string) {
  campusPipelineId(campus);
  const value = new Date(utcStart);
  if (!Number.isFinite(value.getTime()) ||
      value.toISOString() !== utcStart || value.getTime() <= 0) {
    throw new Error("invalid_interview_start");
  }
  return {
    "Interview Date": { date: { start: utcStart } },
    "Interview Status": { select: { name: "Scheduled" } },
    // BC Workflow Status currently lacks "Interview Scheduled". Do not
    // invent a new option or write it in that pipeline.
    ...(campus === "BU"
      ? { "Workflow Status": { select: { name: "Interview Scheduled" } } }
      : {}),
  };
}

export const INTERVIEW_NOTION_SCHEMA_GAPS = {
  missingOnBoth: ["Interviewed By", "Google Meet URL"],
  bcMissingWorkflowOption: "Interview Scheduled",
} as const;
