import {
  campusPipelineId,
  evaluateInitialInterviewEligibility, type Campus,
  type EligibilityResult, type ApplicantInterviewState,
} from "./interview-notion-contract";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export class PreviewNotionReadError extends Error {
  constructor(public readonly code: string) { super(code); }
}

function normalizeId(id: string): string {
  if (!/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(id)) {
    throw new PreviewNotionReadError("invalid_notion_identifier");
  }
  return id.replaceAll("-", "").toLowerCase();
}

export function previewNotionConfiguration():
  { enabled: boolean; buId: string; bcId: string; token: string } {
  if (process.env.VERCEL_ENV !== "preview" ||
      process.env.INTERVIEW_NOTION_READS_ENABLED !== "true") {
    throw new PreviewNotionReadError("preview_notion_reads_disabled");
  }
  const buId = normalizeId(process.env.INTERVIEW_NOTION_BU_STAGING_DB_ID ?? "");
  const bcId = normalizeId(process.env.INTERVIEW_NOTION_BC_STAGING_DB_ID ?? "");
  if (buId === bcId || [campusPipelineId("BU"),campusPipelineId("BC")].includes(buId) ||
      [campusPipelineId("BU"),campusPipelineId("BC")].includes(bcId)) {
    throw new PreviewNotionReadError("production_notion_database_forbidden");
  }
  const token = process.env.INTERVIEW_NOTION_STAGING_TOKEN ?? "";
  if (token.length < 20) throw new PreviewNotionReadError("preview_notion_token_missing");
  return { enabled:true, buId, bcId, token };
}

function selected(p: unknown): string | null {
  if (!p || typeof p !== "object") return null;
  const value = p as { type?: unknown; select?: { name?: unknown } };
  return value.type === "select" && typeof value.select?.name === "string"
    ? value.select.name : null;
}
function email(p: unknown): string {
  if (!p || typeof p !== "object") return "";
  const value = p as { type?: unknown; email?: unknown };
  return value.type === "email" && typeof value.email === "string"
    ? value.email.trim().toLowerCase() : "";
}

/**
 * This is deliberately READ-ONLY. The records in these clone databases
 * must be SYNTHETIC. Real volunteer records may not be read in preview.
 * The returned object contains only eligibility, never raw applicant fields.
 */
export async function checkSyntheticNotionInvitationEligibility(
  campus: Campus,
  pageId: string,
  transport: typeof fetch = fetch,
): Promise<EligibilityResult> {
  const cfg = previewNotionConfiguration();
  const expected = campus === "BU" ? cfg.buId : campus === "BC" ? cfg.bcId : "";
  if (!expected) throw new PreviewNotionReadError("invalid_campus");
  const normalizedPageId = normalizeId(pageId);
  let response: Response;
  try {
    response = await transport(NOTION_API + "/pages/" + normalizedPageId, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + cfg.token,
        "Notion-Version": NOTION_VERSION,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new PreviewNotionReadError("preview_notion_unreachable");
  }
  if (!response.ok) throw new PreviewNotionReadError("preview_notion_lookup_failed");
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new PreviewNotionReadError("preview_notion_invalid_response"); }
  if (!payload || typeof payload !== "object") {
    throw new PreviewNotionReadError("preview_notion_invalid_response");
  }
  const page = payload as {
    id?: unknown; archived?: unknown; in_trash?: unknown;
    parent?: { type?: unknown; database_id?: unknown };
    properties?: Record<string, unknown>;
  };
  if (typeof page.id !== "string" || normalizeId(page.id) !== normalizedPageId ||
      page.archived === true || page.in_trash === true ||
      page.parent?.type !== "database_id" ||
      typeof page.parent.database_id !== "string") {
    throw new PreviewNotionReadError("preview_notion_identity_mismatch");
  }
  try {
    // Strictly compare with the explicitly configured staging ID.
    if (normalizeId(page.parent.database_id) !== expected) {
      throw new PreviewNotionReadError("preview_notion_campus_mismatch");
    }
  } catch (error) {
    if (error instanceof PreviewNotionReadError) throw error;
    throw new PreviewNotionReadError("preview_notion_campus_mismatch");
  }
  // Live production pipeline IDs must never be used as staging parents.
  if (!page.properties) throw new PreviewNotionReadError("preview_notion_invalid_response");

  const state: ApplicantInterviewState = {
    email: email(page.properties.Email),
    stage: selected(page.properties.Stage),
    nextStep: selected(page.properties["Next Step"]),
    interviewStatus: selected(page.properties["Interview Status"]),
    workflowStatus: selected(page.properties["Workflow Status"]),
  };
  if (!state.email.endsWith("@example.invalid")) {
    throw new PreviewNotionReadError("real_applicant_forbidden_in_preview");
  }
  return evaluateInitialInterviewEligibility(campus, state);
}
