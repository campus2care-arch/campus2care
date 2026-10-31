import { createHash, createHmac } from "node:crypto";
import {
  campusPipelineId, evaluateInitialInterviewEligibility,
  type Campus, type ApplicantInterviewState,
} from "./interview-notion-contract";
import { routineOutreachDecision, type RoutineAttempt } from "./interview-dispatch-policy";

export class ProductionAudienceReviewError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export type ProductionPipelineApplicant = ApplicantInterviewState & {
  campus: Campus; pageId: string; archived: boolean;
  interviewDatePresent: boolean; reservationIdPresent: boolean;
  /** Display-only fields for the founder dashboard; never part of eligibility. */
  name?: string; eaOwner?: string | null; interviewDate?: string | null;
};
export type AudienceReviewFacts = {
  reservedHmacs: ReadonlySet<string>;
  completedHmacs: ReadonlySet<string>;
  suppressedHmacs: ReadonlySet<string>;
  optedOutHmacs: ReadonlySet<string>;
  manuallyClearedHmacs: ReadonlySet<string>;
  /** Founder-approved waivers of the configurable follow-up frequency limits. */
  frequencyExceptionHmacs?: ReadonlySet<string>;
  historyByHmac: ReadonlyMap<string, RoutineAttempt[]>;
  capacityByCampus: Record<Campus, boolean>;
  /** Open bookable team slots minus outstanding unbooked invitations, per campus. */
  remainingCapacityByCampus?: Record<Campus, number>;
};
export type AudienceReviewResult = {
  scanned: number;
  countsByDecision: Record<string, number>;
  readyForFounderReview: number;
  manifestSha256: string;
  // HMAC and opaque page identifiers only; never expose names or emails.
  entries: Array<{ campus: Campus; pageId: string; recipientHmac: string; decision: string }>;
};
type NotionPage = {
  id?: unknown; archived?: unknown; in_trash?: unknown;
  parent?: {type?: unknown; database_id?: unknown};
  properties?: Record<string, unknown>;
};
const NOTION_API = "https://api.notion.com/v1/databases/";
const ID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;
const normalizeId = (value: unknown) => {
  if (typeof value !== "string" || !ID.test(value))
    throw new ProductionAudienceReviewError("audience_invalid_notion_id");
  return value.toLowerCase().replaceAll("-", "");
};
function selectField(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const value = input as {type?: unknown; select?: {name?: unknown}};
  return value.type === "select" && typeof value.select?.name === "string" ? value.select.name : null;
}
function emailField(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const value = input as {type?: unknown; email?: unknown};
  return value.type === "email" && typeof value.email === "string" ? value.email.trim().toLowerCase() : "";
}
function titleField(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const value = input as {type?: unknown; title?: Array<{plain_text?: unknown}>};
  return value.type === "title" && Array.isArray(value.title)
    ? value.title.map(part => typeof part.plain_text === "string" ? part.plain_text : "").join("").trim() : "";
}
function dateStart(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const value = input as {type?: unknown; date?: {start?: unknown} | null};
  return value.type === "date" && typeof value.date?.start === "string" ? value.date.start : null;
}
function hasDate(input: unknown): boolean {
  if (!input || typeof input !== "object") return true;
  const value = input as {type?: unknown; date?: unknown};
  return value.type !== "date" || value.date !== null;
}
function hasText(input: unknown): boolean {
  if (!input || typeof input !== "object") return true;
  const value = input as {type?: unknown; rich_text?: Array<{plain_text?: unknown}>};
  return value.type !== "rich_text" || !Array.isArray(value.rich_text) ||
    value.rich_text.some(part => typeof part.plain_text !== "string" || part.plain_text.length > 0);
}

/** Strict read-only feature gate. A preview can never access live applicant data. */
export function requireProductionAudienceReview(env: Record<string, string | undefined> = process.env) {
  if (env.VERCEL_ENV !== "production" || env.INTERVIEW_DATA_ENV !== "production" ||
      env.INTERVIEW_PRODUCTION_APPLICANT_REVIEW_ENABLED !== "true")
    throw new ProductionAudienceReviewError("audience_review_disabled");
  const token = env.INTERVIEW_NOTION_LIVE_TOKEN ?? "";
  if (token.length < 20) throw new ProductionAudienceReviewError("audience_notion_token_missing");
  return token;
}

/**
 * Read actual BU/BC pipeline pages into an in-memory bounded snapshot.
 * No Notion writes, Neon writes, Gmail activity, or applicant tokens.
 * All records must have the expected parent, including archived records.
 */
export async function scanProductionApplicantPipelines(
  transport: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env,
): Promise<ProductionPipelineApplicant[]> {
  const token = requireProductionAudienceReview(env);
  const applicants: ProductionPipelineApplicant[] = [];
  for (const campus of ["BU", "BC"] as const) {
    const databaseId = campusPipelineId(campus);
    let cursor: string | undefined;
    const cursors = new Set<string>();
    let complete = false;
    for (let batch = 0; batch < 10; batch++) {
      let response: Response;
      try {
        response = await transport(NOTION_API + databaseId + "/query", {
          method: "POST",
          headers: {Authorization:"Bearer " + token,"Notion-Version":"2022-06-28",
            "Content-Type":"application/json"},
          body: JSON.stringify({page_size:100,...(cursor ? {start_cursor:cursor} : {})}),
          cache:"no-store",signal:AbortSignal.timeout(8000),
        });
      } catch { throw new ProductionAudienceReviewError("audience_notion_unreachable"); }
      if (!response.ok) throw new ProductionAudienceReviewError(
        response.status === 429 ? "audience_notion_rate_limited" : "audience_notion_query_failed");
      let body: {results?: unknown;has_more?: unknown;next_cursor?: unknown};
      try { body = await response.json(); }
      catch { throw new ProductionAudienceReviewError("audience_notion_invalid_response"); }
      if (!Array.isArray(body.results) || body.results.length > 100 ||
          typeof body.has_more !== "boolean")
        throw new ProductionAudienceReviewError("audience_notion_invalid_response");
      for (const item of body.results) {
        if (!item || typeof item !== "object")
          throw new ProductionAudienceReviewError("audience_notion_invalid_page");
        const page = item as NotionPage;
        const pageId = normalizeId(page.id);
        if (page.parent?.type !== "database_id" ||
            normalizeId(page.parent.database_id) !== databaseId)
          throw new ProductionAudienceReviewError("audience_wrong_campus_parent");
        const properties = page.properties;
        if (!properties || typeof properties !== "object")
          throw new ProductionAudienceReviewError("audience_missing_properties");
        applicants.push({
          campus, pageId, archived:page.archived === true || page.in_trash === true,
          email:emailField(properties.Email), stage:selectField(properties.Stage),
          nextStep:selectField(properties["Next Step"]),
          workflowStatus:selectField(properties["Workflow Status"]),
          interviewStatus:selectField(properties["Interview Status"]),
          interviewDatePresent:hasDate(properties["Interview Date"]),
          reservationIdPresent:hasText(properties["Scheduling Reservation ID"]),
          name:titleField(properties.Volunteer),
          eaOwner:selectField(properties["Executive Associate Owner"]),
          interviewDate:dateStart(properties["Interview Date"]),
        });
      }
      if (!body.has_more) { complete = true; break; }
      if (typeof body.next_cursor !== "string" || !body.next_cursor ||
          cursors.has(body.next_cursor))
        throw new ProductionAudienceReviewError("audience_invalid_cursor");
      cursor = body.next_cursor;
      cursors.add(cursor);
    }
    if (!complete) throw new ProductionAudienceReviewError("audience_scan_truncated");
  }
  return applicants;
}
function recipientHmac(email:string, key:string) {
  if (key.length < 32) throw new ProductionAudienceReviewError("audience_auth_secret_missing");
  return createHmac("sha256",key).update("recipient:" + email.trim().toLowerCase()).digest("hex");
}

/** Pure, deterministic dry run. No message may be sent based on this review alone. */
export function reviewProductionApplicantAudience(input: {
  applicants: ProductionPipelineApplicant[];
  facts: AudienceReviewFacts;
  authSecret: string;
  now: Date;
}): AudienceReviewResult {
  if (!Number.isFinite(input.now.getTime()))
    throw new ProductionAudienceReviewError("audience_invalid_review_time");
  if (input.authSecret.length < 32)
    throw new ProductionAudienceReviewError("audience_auth_secret_missing");
  const perEmail = new Map<string,number>();
  const perPage = new Map<string,number>();
  for (const row of input.applicants) {
    const mail = row.email.trim().toLowerCase();
    if (mail) perEmail.set(mail,(perEmail.get(mail)??0)+1);
    const page = row.pageId.toLowerCase();
    perPage.set(page,(perPage.get(page)??0)+1);
  }
  const countsByDecision: Record<string,number> = {};
  const entries: AudienceReviewResult["entries"] = [];
  for (const row of [...input.applicants].sort((a,b)=>
    (a.campus+":"+a.pageId).localeCompare(b.campus+":"+b.pageId))) {
    const pageId=normalizeId(row.pageId);
    const email=row.email.trim().toLowerCase();
    const hmac=recipientHmac(email,input.authSecret);
    const state=evaluateInitialInterviewEligibility(row.campus,{...row,email});
    let decision: string = state.eligible ? "eligible_for_founder_review" : state.reason;
    if (row.archived) decision="archived";
    else if(row.interviewDatePresent||row.reservationIdPresent) decision="interview_already_processed";
    else if(perPage.get(pageId)!==1 || (email && perEmail.get(email)!==1))
      decision="duplicate_across_pipelines";
    else if(input.facts.optedOutHmacs.has(hmac)||input.facts.suppressedHmacs.has(hmac))
      decision="suppressed_or_opted_out";
    else if(input.facts.reservedHmacs.has(hmac)||input.facts.completedHmacs.has(hmac))
      decision="prior_booking_or_interview";
    else if(decision==="eligible_for_founder_review") {
      const spacing=routineOutreachDecision(input.facts.historyByHmac.get(hmac)??[],input.now.getTime(),
        undefined,{frequencyException:input.facts.frequencyExceptionHmacs?.has(hmac)===true});
      if(spacing!=="eligible") decision=spacing;
      else if(input.facts.capacityByCampus[row.campus]!==true) decision="no_confirmed_capacity";
      else if(!input.facts.manuallyClearedHmacs.has(hmac)) decision="manual_outreach_not_reconciled";
    }
    countsByDecision[decision]=(countsByDecision[decision]??0)+1;
    entries.push({campus:row.campus,pageId,recipientHmac:hmac,decision});
  }
  const digest=createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  return {scanned:entries.length,countsByDecision,
    readyForFounderReview:countsByDecision.eligible_for_founder_review??0,
    manifestSha256:digest,entries};
}
