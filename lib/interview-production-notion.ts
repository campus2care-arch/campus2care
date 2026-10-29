import {
import { productionRealEnabled, productionRealConfig, assertProductionBookingIdentity } from "./interview-production-launch";

// Production-real mode is a separate explicit release. Canary-only routes
// retain their original canary guards and cannot be widened by this adapter.

const requireProductionIdentity = (...args: Parameters<typeof assertProductionCanaryIdentity>) =>
  productionRealEnabled()
    ? assertProductionBookingIdentity(args[0],args[1],args[2])
    : assertProductionCanaryIdentity(...args);
  assertCampusPipelineParent, evaluateInitialInterviewEligibility,
  type ApplicantInterviewState, type Campus,
} from "./interview-notion-contract";
import { assertProductionCanaryIdentity } from "./interview-production-canary";
import { assertProductionVerificationIdentity } from "./interview-production-verification-gate";

type Field = { type?: unknown; email?: unknown; select?: { name?: unknown }; rich_text?: Array<{ plain_text?: unknown }> };
type Page = {
  id?: unknown; archived?: unknown; in_trash?: unknown;
  parent?: { database_id?: unknown; type?: unknown };
  properties?: Record<string, Field>;
};
function currentSelect(value: Field | undefined): string | null {
  return value?.type === "select" && typeof value.select?.name === "string" ? value.select.name : null;
}
function currentEmail(value: Field | undefined): string | null {
  return value?.type === "email" && typeof value.email === "string" ?
    value.email.trim().toLowerCase() : null;
}
function currentText(value: Field | undefined): string {
  return Array.isArray(value?.rich_text) ? value.rich_text
    .map(x => typeof x.plain_text === "string" ? x.plain_text : "").join("") : "";
}
function normalizeId(value: unknown): string {
  if (typeof value !== "string" ||
      !/^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(value)) {
    throw new Error("interview_production_notion_identity_invalid");
  }
  return value.toLowerCase().replaceAll("-", "");
}

/**
 * Read a live Notion applicant by immutable page ID. No writes, no search,
 * no storage and no volunteer ownership changes. A positive result can only
 * be used by a separately authorized booking transaction for this SAME page.
 */
export async function verifyLiveCanaryApplicant(
  input: { campus: Campus; pageId: string; email: string; reservationId?: string },
  options: { token?: string; transport?: typeof fetch; verificationOnly?: boolean } = {},
): Promise<{ campus: Campus; notionPageId: string; recipientEmail: string }> {
  const approved = options.verificationOnly === true
    ? assertProductionVerificationIdentity(input.campus, input.email, input.pageId)
    : requireProductionIdentity(input.campus, input.email, input.pageId);
  const token = options.token ?? process.env["INTERVIEW_NOTION_LIVE_TOKEN"] ?? "";
  if (token.length < 20) throw new Error("interview_production_notion_not_configured");
  const transport = options.transport ?? fetch;
  let response: Response;
  try {
    response = await transport("https://api.notion.com/v1/pages/" + approved.pageId, {
      headers: { Authorization: "Bearer " + token, "Notion-Version": "2022-06-28" },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new Error("interview_production_notion_unreachable");
  }
  if (!response.ok) throw new Error(response.status === 429 ?
    "interview_production_notion_rate_limited" : "interview_production_notion_unavailable");
  let page: Page;
  try { page = await response.json() as Page; }
  catch { throw new Error("interview_production_notion_invalid_response"); }
  if (normalizeId(page.id) !== approved.pageId ||
      page.archived === true || page.in_trash === true ||
      page.parent?.type !== "database_id") {
    throw new Error("interview_production_notion_identity_invalid");
  }
  assertCampusPipelineParent(approved.campus, normalizeId(page.parent.database_id));
  const fields = page.properties;
  if (!fields) throw new Error("interview_production_notion_missing_properties");
  const actualEmail = currentEmail(fields["Email"]);
  if (actualEmail !== approved.email) throw new Error("interview_production_notion_email_mismatch");
  if (input.reservationId) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.reservationId) ||
        currentText(fields["Scheduling Reservation ID"]) !== input.reservationId ||
        currentSelect(fields["Interview Status"]) !== "Scheduled" ||
        currentSelect(fields.Stage) !== "Needs Interview" ||
        currentSelect(fields["Next Step"]) !== "Schedule interview" ||
        currentSelect(fields["Workflow Status"]) !== (approved.campus === "BU" ? "Interview Scheduled" : "Application Received")) {
      throw new Error("interview_production_notion_booking_changed");
    }
    return { campus: approved.campus, notionPageId: approved.pageId, recipientEmail: approved.email };
  }
  const state: ApplicantInterviewState = {
    email: approved.email,
    stage: currentSelect(fields["Stage"]),
    nextStep: currentSelect(fields["Next Step"]),
    interviewStatus: currentSelect(fields["Interview Status"]),
    workflowStatus: currentSelect(fields["Workflow Status"]),
  };
  const decision = evaluateInitialInterviewEligibility(approved.campus, state);
  if (!decision.eligible) throw new Error("interview_production_notion_" + decision.reason);
  if (currentText(fields["Scheduling Reservation ID"])) {
    throw new Error("interview_production_notion_existing_reservation");
  }
  if (fields["Interview Date"]?.type === "date" &&
      (fields["Interview Date"] as Field & { date?: unknown }).date != null) {
    throw new Error("interview_production_notion_existing_date");
  }
  return { campus: approved.campus, notionPageId: approved.pageId, recipientEmail: approved.email };
}
