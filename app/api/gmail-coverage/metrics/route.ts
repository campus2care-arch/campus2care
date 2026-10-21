import { coverage, type Shift } from "./model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
const SOURCE = "899fd868-b9da-44cf-8128-5ce3b368b29d";

async function queryAll(): Promise<Shift[]> {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("Notion service unavailable");
  const shifts: Shift[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < 20; index += 1) {
    const response = await fetch(`https://api.notion.com/v1/data_sources/${SOURCE}/query`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Notion-Version": "2026-03-11" },
      body: JSON.stringify({ page_size: 100, is_archived: false, ...(cursor ? { start_cursor: cursor } : {}) }),
      cache: "no-store", signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("Notion query unavailable");
    const result = await response.json() as { results?: Shift[]; has_more?: boolean; next_cursor?: string | null };
    if (!Array.isArray(result.results)) throw new Error("Incomplete Notion response");
    shifts.push(...result.results);
    if (!result.has_more) return shifts;
    if (!result.next_cursor || result.next_cursor === cursor) throw new Error("Incomplete pagination");
    cursor = result.next_cursor;
  }
  throw new Error("Pagination limit reached");
}
const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive", "Access-Control-Allow-Origin": "*" };
export async function GET(): Promise<Response> {
  try {
    return Response.json(coverage(await queryAll(), new Date()), { headers });
  } catch {
    return Response.json({ error: "Gmail coverage unavailable" }, { status: 503, headers });
  }
}
