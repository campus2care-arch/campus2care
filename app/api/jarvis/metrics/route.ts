export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NOTION_VERSION = "2026-03-11";
const PIPELINE_DATA_SOURCE = "2a3fd7a6-1dcc-4b57-b394-0f8821b3a2c7";
const BC_PIPELINE_DATA_SOURCE = "c62767c6-3b89-4f45-82d5-9b8a17eb71ee";
const TASKS_DATA_SOURCE = "a759e18e-945e-4efe-9749-5d16dd39e758";
const RESEARCH_TEAM_SOURCE = "c1ebdb3e-649c-4c5a-9ed2-e1099ac673ce";
const RESEARCH_CANDIDATE_SOURCE = "2715ffc8-cf3e-4c01-8239-48ab03eb6988";
const CURRENT_CANDIDATE_ROUND = "Protocol v1.6 October 2026 candidate test round";
const MAX_PAGES = 20;

type NotionProperty = {
  title?: Array<{ plain_text?: string }>;
  rich_text?: Array<{ plain_text?: string }>;
  select?: { name?: string } | null;
  status?: { name?: string } | null;
  formula?: { string?: string } | null;
  email?: string | null;
  multi_select?: Array<{ name?: string }>;
  date?: { start?: string; end?: string | null } | null;
};

type NotionPage = {
  properties?: Record<string, NotionProperty>;
  in_trash?: boolean;
  is_archived?: boolean;
  archived?: boolean;
};

function propertyText(property?: NotionProperty): string {
  if (!property) return "";
  return (
    property.select?.name ??
    property.status?.name ??
    property.formula?.string ??
    property.email ??
    property.title?.map((part) => part.plain_text ?? "").join("") ??
    property.rich_text?.map((part) => part.plain_text ?? "").join("") ??
    ""
  ).trim();
}

async function queryAllPages(dataSourceId: string): Promise<NotionPage[]> {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("Notion service is not configured");

  const pages: NotionPage[] = [];
  let startCursor: string | undefined;

  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const response = await fetch(
      `https://api.notion.com/v1/data_sources/${dataSourceId}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Notion-Version": NOTION_VERSION,
        },
        body: JSON.stringify({
          page_size: 100,
          is_archived: false,
          ...(startCursor ? { start_cursor: startCursor } : {}),
        }),
        signal: AbortSignal.timeout(10000),
        cache: "no-store",
      },
    );

    if (!response.ok) {
      console.error("Jarvis metrics Notion query failed", {
        dataSourceId,
        status: response.status,
      });
      throw new Error("Notion metrics query failed");
    }

    const result = (await response.json()) as {
      results?: NotionPage[];
      has_more?: boolean;
      next_cursor?: string | null;
    };
    pages.push(...(result.results ?? []));

    if (!result.has_more) return pages;
    if (!result.next_cursor) throw new Error("Notion metrics pagination was incomplete");
    startCursor = result.next_cursor;
  }

  throw new Error("Notion metrics pagination exceeded its safety limit");
}

function isVolunteerRecord(page: NotionPage): boolean {
  if (page.in_trash || page.is_archived || page.archived) return false;
  const p = page.properties ?? {};
  // Mirror the JARVIS volunteer chart: a named record other than the QA test.
  const name = propertyText(p.Volunteer);
  return Boolean(name) && name !== "Campus2Care QA Test";
}

// Keep the same stage labels and blank-stage bucket as the native Notion chart.
const STAGE_NAMES = ["Cleared", "Hospital Onboarding", "Needs Interview", "Needs Placement", "Needs Workshop", "No Stage"] as const;
type StageName = (typeof STAGE_NAMES)[number];

function campusPipelineSummary(pages: NotionPage[]) {
  const stages = Object.fromEntries(STAGE_NAMES.map(stage => [stage, 0])) as Record<StageName, number>;
  for (const page of pages) {
    if (!isVolunteerRecord(page)) continue;
    const stage = propertyText(page.properties?.Stage);
    const group = STAGE_NAMES.some(name => name === stage) ? stage as StageName : "No Stage";
    stages[group] += 1;
  }
  return { total: Object.values(stages).reduce((sum, count) => sum + count, 0), cleared: stages.Cleared, stages };
}

function easternDate(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(value);
}

function isDueTask(page: NotionPage, today: string): boolean {
  if (!isOpenTask(page)) return false;
  const due = page.properties?.Due?.date;
  const value = due?.end || due?.start;
  if (!value) return false;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : easternDate(new Date(value));
  return day <= today;
}

function isOpenTask(page: NotionPage): boolean {
  if (page.in_trash || page.is_archived || page.archived) return false;
  const properties = page.properties ?? {};
  const status = propertyText(properties.Status);
  return status !== "Done" && status !== "Archived";
}

// Assessment completion covers the original reviewed/selected student cohort and
// the current October candidate round. Research preparation is an independent
// assignment stage and cannot undo an already completed selection assessment.
// Work is deduplicated by normalized email; neither a submission nor selection
// grants scientific research-production authorization.
function orientationProgress(candidatePages: NotionPage[], teamPages: NotionPage[]) {
  const email = (value: string) => value.trim().toLowerCase();
  // The original selected cohort must still be participating in the current
  // student-preparation roster. Exclude leadership/governance assignments.
  const teamEmails = new Set(
    teamPages.filter(page => {
      if (page.in_trash || page.is_archived || page.archived) return false;
      return !/^Leadership\s*\|/i.test(propertyText(page.properties?.Assignment));
    }).map(page => email(propertyText(page.properties?.["Owner Email"]))).filter(Boolean),
  );
  const selected = new Set<string>();
  const active = new Map<string, { completed: boolean; started: boolean }>();
  let newSubmitted = 0;
  let awaitingReview = 0;
  let declined = 0;

  for (const page of candidatePages) {
    if (page.in_trash || page.is_archived || page.archived) continue;
    const p = page.properties ?? {};
    const key = email(propertyText(p.Email));
    if (!key) continue;
    const stage = propertyText(p["Stage 2 Status"]);
    if (propertyText(p["Internal Review Notes"]).includes(CURRENT_CANDIDATE_ROUND)) {
      if (propertyText(p["Research Participation"]) === "Declined") {
        declined += 1;
        continue;
      }
      const submitted = stage === "Submitted" || stage === "Reviewed";
      active.set(key, {
        completed: submitted,
        started: ["In Progress", "Submitted", "Reviewed"].includes(stage),
      });
      if (submitted) {
        newSubmitted += 1;
        if (stage !== "Reviewed") awaitingReview += 1;
      }
      continue;
    }
    // September results are a separate, reviewed assessment, not evidence
    // that the October research-preparation task is already approved.
    if (teamEmails.has(key) &&
        propertyText(p["Final Decision"]) === "Selected" &&
        stage === "Reviewed") {
      selected.add(key);
    }
  }
  for (const key of selected) {
    if (!active.has(key)) active.set(key, { completed: true, started: true });
  }
  const work = [...active.values()];
  const completed = work.filter(item => item.completed).length;
  const total = work.length;
  const inProgress = work.filter(item => !item.completed && item.started).length;
  return {
    phase: "orientation",
    completed,
    total,
    inProgress,
    selected: selected.size,
    newSubmitted,
    awaitingReview,
    awaitingSubmission: total - completed,
    declined,
  };
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Accept",
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Accept",
      "Access-Control-Max-Age": "86400",
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(): Promise<Response> {
  try {
    const [pipelinePages, bcPipelinePages, taskPages, candidatePages, teamPages] = await Promise.all([
      queryAllPages(PIPELINE_DATA_SOURCE),
      queryAllPages(BC_PIPELINE_DATA_SOURCE),
      queryAllPages(TASKS_DATA_SOURCE),
      queryAllPages(RESEARCH_CANDIDATE_SOURCE),
      queryAllPages(RESEARCH_TEAM_SOURCE),
    ]);
    const today = easternDate(new Date());
    const campuses = {
      BU: campusPipelineSummary(pipelinePages),
      BC: campusPipelineSummary(bcPipelinePages),
    };
    return jsonResponse({
      totalVolunteers: campuses.BU.total + campuses.BC.total,
      clearedVolunteers: campuses.BU.cleared + campuses.BC.cleared,
      campuses,
      dueTasks: taskPages.filter(page => isDueTask(page, today)).length,
      research: orientationProgress(candidatePages, teamPages),
      updatedAt: new Date().toISOString(),
    });
  } catch {
    return jsonResponse({ error: "Live metrics are temporarily unavailable" }, 503);
  }
}
