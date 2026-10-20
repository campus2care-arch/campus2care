export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NOTION_VERSION = "2026-03-11";
const PIPELINE_DATA_SOURCE = "2a3fd7a6-1dcc-4b57-b394-0f8821b3a2c7";
const TASKS_DATA_SOURCE = "a759e18e-945e-4efe-9749-5d16dd39e758";
const RESEARCH_TEAM_SOURCE = "c1ebdb3e-649c-4c5a-9ed2-e1099ac673ce";
const RESEARCH_CANDIDATE_SOURCE = "2715ffc8-cf3e-4c01-8239-48ab03eb6988";
const CURRENT_CANDIDATE_ROUND = "Protocol v1.6 October 2026 candidate test round";
const INACTIVE_STATUSES = new Set(["Paused", "Withdrawn / Not Proceeding"]);
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
  const identity = `${propertyText(p.Volunteer)} ${propertyText(p.Email)}`.trim();
  return Boolean(identity) && !/PRODUCTION QA TEST ONLY/i.test(`${identity} ${propertyText(p.Notes)}`);
}

function isHospitalCleared(page: NotionPage): boolean {
  const p = page.properties ?? {};
  const flags = (p["Cleared to Start by Hospital"]?.multi_select ?? []).map(option => option.name);
  return isVolunteerRecord(page) && !INACTIVE_STATUSES.has(propertyText(p["Workflow Status"])) &&
    flags.includes("Yes") && !flags.includes("No");
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

// One orientation participant per normalized email. A participant completes
// orientation only when all of their current assessment/preparation work is complete.
// Keep scientific launch approvals separate from student orientation progress.
function orientationProgress(candidatePages: NotionPage[], teamPages: NotionPage[]) {
  const participants = new Map<string, Array<{ complete: boolean; started: boolean }>>();
  const add = (email: string, complete: boolean, started: boolean) => {
    const key = email.trim().toLowerCase();
    if (!key) return;
    participants.set(key, [...(participants.get(key) ?? []), { complete, started }]);
  };
  for (const page of candidatePages) {
    if (page.in_trash || page.is_archived || page.archived) continue;
    const p = page.properties ?? {};
    if (!propertyText(p["Internal Review Notes"]).includes(CURRENT_CANDIDATE_ROUND)) continue;
    const status = propertyText(p["Stage 2 Status"]);
    add(propertyText(p.Email), ["Submitted", "Reviewed"].includes(status),
      ["In Progress", "Submitted", "Reviewed"].includes(status));
  }
  for (const page of teamPages) {
    if (page.in_trash || page.is_archived || page.archived) continue;
    const p = page.properties ?? {};
    if (/^Leadership\s*\|/i.test(propertyText(p.Assignment))) continue;
    const status = propertyText(p.Status);
    add(propertyText(p["Owner Email"]), status === "Approved as training complete",
      ["In preparation", "Needs supervisor review", "Approved as training complete"].includes(status));
  }
  const work = [...participants.values()];
  return {
    phase: "orientation",
    completed: work.filter(items => items.every(item => item.complete)).length,
    total: work.length,
    inProgress: work.filter(items => !items.every(item => item.complete) && items.some(item => item.started)).length,
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
    const [pipelinePages, taskPages, candidatePages, teamPages] = await Promise.all([
      queryAllPages(PIPELINE_DATA_SOURCE),
      queryAllPages(TASKS_DATA_SOURCE),
      queryAllPages(RESEARCH_CANDIDATE_SOURCE),
      queryAllPages(RESEARCH_TEAM_SOURCE),
    ]);
    const today = easternDate(new Date());
    return jsonResponse({
      totalVolunteers: pipelinePages.filter(isVolunteerRecord).length,
      clearedVolunteers: pipelinePages.filter(isHospitalCleared).length,
      dueTasks: taskPages.filter(page => isDueTask(page, today)).length,
      research: orientationProgress(candidatePages, teamPages),
      updatedAt: new Date().toISOString(),
    });
  } catch {
    return jsonResponse({ error: "Live metrics are temporarily unavailable" }, 503);
  }
}
