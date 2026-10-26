export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const PIPELINE_SOURCE = "c62767c6-3b89-4f45-82d5-9b8a17eb71ee";
const AVAILABILITY_SOURCE = "561cdbe5-e97b-45af-a5c9-8148b721c833";
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

type Property = {
  title?: { plain_text?: string }[];
  rich_text?: { plain_text?: string }[];
  email?: string | null;
  select?: { name?: string } | null;
  checkbox?: boolean;
  relation?: { id: string }[];
};
type Page = { id: string; properties?: Record<string, Property>; archived?: boolean; is_archived?: boolean; in_trash?: boolean };

function text(property?: Property): string {
  return (property?.email ?? property?.select?.name ??
    (property?.title ?? property?.rich_text ?? []).map(part => part.plain_text ?? "").join("")).trim();
}
function active(page: Page): boolean {
  return !page.archived && !page.is_archived && !page.in_trash;
}
function id(value: string): string { return value.replace(/-/g, "").toLowerCase(); }
function email(value: string): string { return value.trim().toLowerCase(); }
function name(value: string): string { return value.trim().replace(/\s+/g, " ").toLowerCase(); }

async function queryAll(source: string): Promise<Page[]> {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("Notion service unavailable");
  const pages: Page[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < 20; index += 1) {
    const response = await fetch(`https://api.notion.com/v1/data_sources/${source}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Notion-Version": "2026-03-11" },
      body: JSON.stringify({ page_size: 100, is_archived: false, ...(cursor ? { start_cursor: cursor } : {}) }),
      signal: AbortSignal.timeout(10000), cache: "no-store",
    });
    if (!response.ok) throw new Error("Notion query unavailable");
    const data = await response.json() as { results?: Page[]; has_more?: boolean; next_cursor?: string | null };
    if (!Array.isArray(data.results)) throw new Error("Incomplete Notion response");
    pages.push(...data.results);
    if (!data.has_more) return pages;
    if (!data.next_cursor || data.next_cursor === cursor) throw new Error("Incomplete Notion pagination");
    cursor = data.next_cursor;
  }
  throw new Error("Notion pagination limit reached");
}

function counts(pipeline: Page[], profiles: Page[]) {
  // Match the BC-only named applicant total; never query BU.
  const volunteers = pipeline.filter(page => active(page) && Boolean(text(page.properties?.Volunteer)) && text(page.properties?.Volunteer) !== "Campus2Care QA Test");
  const byId = new Map(volunteers.map(page => [id(page.id), page]));
  const byEmail = new Map<string, Set<string>>();
  const byName = new Map<string, Set<string>>();
  const add = (index: Map<string, Set<string>>, key: string, pageId: string) => {
    if (!key) return;
    if (!index.has(key)) index.set(key, new Set());
    index.get(key)!.add(pageId);
  };
  for (const page of volunteers) {
    add(byEmail, email(text(page.properties?.Email)), id(page.id));
    add(byEmail, email(text(page.properties?.["Alternate Email"])), id(page.id));
    add(byName, name(text(page.properties?.Volunteer)), id(page.id));
  }
  const completed = new Set<string>();
  for (const profile of profiles) {
    const p = profile.properties ?? {};
    // Use the existing Completed Availability view's status rules and ignore history.
    if (!active(profile) || p.Superseded?.checkbox || p["Needs New Availability"]?.checkbox || text(p["Identity Status"]) !== "Confirmed") continue;
    if (!DAYS.every(day => Boolean(text(p[day])))) continue;
    const linked = (p["Volunteer Record"]?.relation ?? []).map(item => id(item.id)).filter(key => byId.has(key));
    if (linked.length === 1) { completed.add(linked[0]); continue; }
    if (linked.length > 1) continue;
    // Email is the primary identity key; full name is a unique-only fallback.
    const matches = byEmail.get(email(text(p.Email)));
    if (matches?.size === 1) { completed.add([...matches][0]); continue; }
    if (matches?.size) continue;
    const names = byName.get(name(text(p.Volunteer)));
    if (names?.size === 1) completed.add([...names][0]);
  }
  return { totalVolunteers: volunteers.length, completedAvailabilityProfiles: completed.size, missingAvailabilityProfiles: volunteers.length - completed.size };
}

const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive", "Access-Control-Allow-Origin": "*" };
export async function GET(): Promise<Response> {
  try {
    const [pipeline, profiles] = await Promise.all([queryAll(PIPELINE_SOURCE), queryAll(AVAILABILITY_SOURCE)]);
    return Response.json({ ...counts(pipeline, profiles), updatedAt: new Date().toISOString() }, { headers });
  } catch {
    // Publish aggregates only, including when a query or configuration fails.
    return Response.json({ error: "BC availability metrics unavailable" }, { status: 503, headers });
  }
}
