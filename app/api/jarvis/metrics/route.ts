import { timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NOTION_VERSION = "2026-03-11";
const PIPELINE_DATA_SOURCE = "2a3fd7a6-1dcc-4b57-b394-0f8821b3a2c7";
const TASKS_DATA_SOURCE = "a759e18e-945e-4efe-9749-5d16dd39e758";
const ACTIVE_STAGES = new Set([
  "Needs Interview",
  "Needs Placement",
  "Needs Workshop",
  "Hospital Onboarding",
  "Cleared",
]);
const INACTIVE_STATUSES = new Set(["Paused", "Withdrawn / Not Proceeding"]);
const MAX_PAGES = 20;

type NotionProperty = {
  title?: Array<{ plain_text?: string }>;
  rich_text?: Array<{ plain_text?: string }>;
  select?: { name?: string } | null;
  status?: { name?: string } | null;
  formula?: { string?: string } | null;
};

type NotionPage = {
  properties?: Record<string, NotionProperty>;
  in_trash?: boolean;
  is_archived?: boolean;
};

function propertyText(property?: NotionProperty): string {
  if (!property) return "";
  return (
    property.select?.name ??
    property.status?.name ??
    property.formula?.string ??
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

    if (!response.ok) throw new Error("Notion metrics query failed");

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

function isCountablePipelineRecord(page: NotionPage): boolean {
  if (page.in_trash || page.is_archived) return false;
  const properties = page.properties ?? {};
  const stage = propertyText(properties.Stage);
  const workflowStatus = propertyText(properties["Workflow Status"]);
  const volunteer = propertyText(properties.Volunteer);
  const notes = propertyText(properties.Notes);

  return (
    ACTIVE_STAGES.has(stage) &&
    !INACTIVE_STATUSES.has(workflowStatus) &&
    !/PRODUCTION QA TEST ONLY/i.test(`${volunteer} ${notes}`)
  );
}

function isOpenTask(page: NotionPage): boolean {
  if (page.in_trash || page.is_archived) return false;
  const properties = page.properties ?? {};
  const title = propertyText(properties["Task name"]);
  const status = propertyText(properties.Status);
  return Boolean(title) && status !== "Done" && status !== "Archived";
}

function jsonResponse(body: Record<string, number | string>, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Accept",
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
      "Access-Control-Allow-Headers": "Authorization, Accept",
      "Access-Control-Max-Age": "86400",
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  const expectedKey = process.env.JARVIS_METRICS_KEY ?? "";
  const suppliedKey = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";

  if (
    !expectedKey ||
    suppliedKey.length !== expectedKey.length ||
    !timingSafeEqual(Buffer.from(suppliedKey), Buffer.from(expectedKey))
  ) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  try {
    const [pipelinePages, taskPages] = await Promise.all([
      queryAllPages(PIPELINE_DATA_SOURCE),
      queryAllPages(TASKS_DATA_SOURCE),
    ]);

    const activePipeline = pipelinePages.filter(isCountablePipelineRecord);
    const needsInterview = activePipeline.filter(
      (page) => propertyText(page.properties?.Stage) === "Needs Interview",
    ).length;
    const needsPlacement = activePipeline.filter(
      (page) => propertyText(page.properties?.Stage) === "Needs Placement",
    ).length;
    const openTasks = taskPages.filter(isOpenTask).length;

    return jsonResponse({
      activePipeline: activePipeline.length,
      needsInterview,
      needsPlacement,
      openTasks,
      updatedAt: new Date().toISOString(),
    });
  } catch {
    return jsonResponse({ error: "Live metrics are temporarily unavailable" }, 503);
  }
}
