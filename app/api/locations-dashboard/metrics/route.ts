export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const LOCATION_SOURCE = "695d8332-06d6-4c35-b886-eb9b89bdccc8";
type Page = {
  id: string;
  archived?: boolean;
  is_archived?: boolean;
  in_trash?: boolean;
  properties?: {
    Location?: { title?: { plain_text?: string }[] };
    Active?: { checkbox?: boolean };
    "Application Status"?: { select?: { name?: string } | null };
  };
};

async function queryLocations(): Promise<Page[]> {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("Notion service unavailable");
  const pages: Page[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < 20; index += 1) {
    const response = await fetch(`https://api.notion.com/v1/data_sources/${LOCATION_SOURCE}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Notion-Version": "2026-03-11" },
      body: JSON.stringify({ page_size: 100, is_archived: false,
        filter: { property: "Active", checkbox: { equals: true } },
        ...(cursor ? { start_cursor: cursor } : {}) }),
      signal: AbortSignal.timeout(10000), cache: "no-store",
    });
    if (!response.ok) {
      console.error("Location dashboard Notion query failed", { status: response.status });
      throw new Error("Notion query unavailable");
    }
    const data = await response.json() as { results?: Page[]; has_more?: boolean; next_cursor?: string | null };
    if (!Array.isArray(data.results)) throw new Error("Incomplete Notion response");
    pages.push(...data.results);
    if (!data.has_more) return pages;
    if (!data.next_cursor || data.next_cursor === cursor) throw new Error("Incomplete Notion pagination");
    cursor = data.next_cursor;
  }
  throw new Error("Notion pagination limit reached");
}

const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive", "Access-Control-Allow-Origin": "*" };
export async function GET(): Promise<Response> {
  try {
    const pages = await queryLocations();
    const counts = { applicationsNotNeeded: 0, applicationsApproved: 0, applicationsDrafting: 0, applicationsNotStarted: 0 };
    const keys = new Map<string, keyof typeof counts>([
      ["Not Needed", "applicationsNotNeeded"], ["Approved", "applicationsApproved"],
      ["Drafting", "applicationsDrafting"], ["Not Started", "applicationsNotStarted"],
    ]);
    const seen = new Set<string>();
    for (const page of pages) {
      const p = page.properties ?? {};
      if (page.archived || page.is_archived || page.in_trash || !p.Active?.checkbox || seen.has(page.id)) continue;
      if (!(p.Location?.title ?? []).some(part => part.plain_text?.trim())) continue;
      seen.add(page.id);
      const key = keys.get(p["Application Status"]?.select?.name ?? "");
      if (key) counts[key] += 1;
    }
    // Match the active Location Directory view; expose no location/contact details.
    return Response.json({ ...counts, updatedAt: new Date().toISOString() }, { headers });
  } catch {
    return Response.json({ error: "Location metrics unavailable" }, { status: 503, headers });
  }
}
