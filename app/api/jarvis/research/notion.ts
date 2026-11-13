import {
  ASSIGNMENTS_SOURCE,
  DELIVERABLES_SOURCE,
  METHODS_GATE_SOURCE,
  UPDATES_SOURCE,
  buildResearchPanel,
  researchStatusId,
  type NotionPage,
  type ResearchPanel,
  type SourceResult,
} from "./model";

const NOTION_VERSION = "2026-03-11";
const MAX_PAGES = 20;

function token(): string {
  return process.env.NOTION_TOKEN?.trim() ?? "";
}

function notionHeaders(secret: string): HeadersInit {
  return {
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
    "Notion-Version": NOTION_VERSION,
  };
}

async function queryOnce(dataSourceId: string, secret: string): Promise<SourceResult> {
  const pages: NotionPage[] = [];
  let startCursor: string | undefined;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    let response: Response;
    try {
      response = await fetch(`https://api.notion.com/v1/data_sources/${dataSourceId}/query`, {
        method: "POST",
        headers: notionHeaders(secret),
        body: JSON.stringify({
          page_size: 100,
          is_archived: false,
          ...(startCursor ? { start_cursor: startCursor } : {}),
        }),
        signal: AbortSignal.timeout(10000),
        cache: "no-store",
      });
    } catch {
      return { access: "unavailable", pages: [] };
    }
    if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404) {
      return { access: "no-access", pages: [] };
    }
    if (!response.ok) return { access: "unavailable", pages: [] };
    const result = (await response.json()) as {
      results?: NotionPage[];
      has_more?: boolean;
      next_cursor?: string | null;
    };
    pages.push(...(result.results ?? []));
    if (!result.has_more) return { access: "ok", pages };
    if (!result.next_cursor) return { access: "unavailable", pages: [] };
    startCursor = result.next_cursor;
  }
  return { access: "unavailable", pages: [] };
}

async function resolveDatabaseSource(databaseId: string, secret: string): Promise<string | null> {
  try {
    const response = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
      headers: notionHeaders(secret),
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { data_sources?: Array<{ id?: string }> };
    const id = body.data_sources?.[0]?.id;
    return typeof id === "string" && id !== databaseId ? id : null;
  } catch {
    return null;
  }
}

export async function queryDataSource(dataSourceId: string, resolveDatabase = false): Promise<SourceResult> {
  const secret = token();
  if (!secret) return { access: "no-access", pages: [] };
  const direct = await queryOnce(dataSourceId, secret);
  if (!resolveDatabase || direct.access !== "no-access") return direct;
  const resolved = await resolveDatabaseSource(dataSourceId, secret);
  if (!resolved) return direct;
  return queryOnce(resolved, secret);
}

export async function loadResearchPanel(now = new Date()): Promise<ResearchPanel> {
  const statusId = researchStatusId();
  const [assignments, methodsGate, status, deliverables, updates] = await Promise.all([
    queryDataSource(ASSIGNMENTS_SOURCE),
    queryDataSource(METHODS_GATE_SOURCE),
    statusId ? queryDataSource(statusId, true) : Promise.resolve({ access: "not-configured" as const, pages: [] }),
    queryDataSource(DELIVERABLES_SOURCE),
    queryDataSource(UPDATES_SOURCE),
  ]);
  return buildResearchPanel({
    updatedAt: now.toISOString(),
    assignments,
    methodsGate,
    status,
    deliverables,
    updates,
  });
}
