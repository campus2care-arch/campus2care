export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NOTION_VERSION = "2026-03-11";
const PIPELINE_DATA_SOURCE = "2a3fd7a6-1dcc-4b57-b394-0f8821b3a2c7";
const MAX_PAGES = 20;
const PAGE_SIZE = 100;

// These are the existing ten assignment-owner lanes, including Emily's own
// caseload. Newly assigned owners are included dynamically as well.
const CURRENT_OWNER_ORDER = [
  "Allison", "Anjolie", "Barthina", "Cayla", "Cori",
  "Edla", "Emily", "Hannah", "Juliette", "Nitara",
];

type NotionProperty = {
  title?: Array<{ plain_text?: string }>;
  select?: { name?: string } | null;
  status?: { name?: string } | null;
  date?: { start?: string | null; end?: string | null } | null;
};
type NotionPage = {
  properties?: Record<string, NotionProperty>;
  archived?: boolean;
  is_archived?: boolean;
  in_trash?: boolean;
};
type OwnerCount = { name: string; assigned: number; reviewed: number; overdue: number };

function selected(property?: NotionProperty): string {
  return (property?.select?.name ?? property?.status?.name ?? "").trim();
}

function title(property?: NotionProperty): string {
  return (property?.title ?? []).map(item => item.plain_text ?? "").join("").trim();
}

function easternDay(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(value);
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function utcDay(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`);
}

function reviewedWithinSevenDays(lastReviewed: string | undefined, today: string): boolean {
  if (!lastReviewed) return false;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(lastReviewed)
    ? lastReviewed
    : easternDay(new Date(lastReviewed));
  const stamp = utcDay(day);
  const now = utcDay(today);
  if (!Number.isFinite(stamp) || !Number.isFinite(now)) return false;
  return Math.floor((now - stamp) / 86400000) < 7;
}

async function loadPipeline(): Promise<NotionPage[]> {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("Notion integration not configured");
  const all: NotionPage[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const res = await fetch(
      `https://api.notion.com/v1/data_sources/${PIPELINE_DATA_SOURCE}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Notion-Version": NOTION_VERSION,
        },
        body: JSON.stringify({
          page_size: PAGE_SIZE,
          is_archived: false,
          ...(cursor ? { start_cursor: cursor } : {}),
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!res.ok) {
      console.error("EA follow-up Notion query failed", { status: res.status });
      throw new Error("Notion source unavailable");
    }
    const json = (await res.json()) as {
      results?: NotionPage[];
      has_more?: boolean;
      next_cursor?: string | null;
    };
    if (!Array.isArray(json.results)) throw new Error("Invalid Notion response");
    all.push(...json.results);
    if (!json.has_more) return all;
    if (!json.next_cursor || json.next_cursor === cursor) {
      throw new Error("Incomplete Notion pagination");
    }
    cursor = json.next_cursor;
  }
  throw new Error("Notion pagination exceeded safety limit");
}

export async function GET(): Promise<Response> {
  const headers = {
    "Cache-Control": "no-store, max-age=0",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "X-Content-Type-Options": "nosniff",
  };
  try {
    const today = easternDay(new Date());
    const pages = await loadPipeline();
    const byOwner = new Map<string, OwnerCount>();
    for (const name of CURRENT_OWNER_ORDER) {
      byOwner.set(name, { name, assigned: 0, reviewed: 0, overdue: 0 });
    }

    for (const page of pages) {
      if (page.archived || page.is_archived || page.in_trash) continue;
      const p = page.properties ?? {};
      const name = title(p.Volunteer);
      if (!name || name.startsWith("Campus2Care QA Test")) continue;
      const owner = selected(p["Executive Associate Owner"]);
      if (!owner || owner === "Unassigned") continue;
      // Match the native Notion EA Weekly Review Status formula exactly.
      if (["Paused", "Withdrawn"].includes(selected(p["Pipeline Stage"]))) continue;
      if (["Paused", "Withdrawn / Not Proceeding"].includes(selected(p["Workflow Status"]))) continue;

      const bucket = byOwner.get(owner) ?? { name: owner, assigned: 0, reviewed: 0, overdue: 0 };
      bucket.assigned += 1;
      const reviewed = reviewedWithinSevenDays(p["Last Reviewed"]?.date?.start ?? undefined, today);
      if (reviewed) bucket.reviewed += 1;
      else bucket.overdue += 1;
      byOwner.set(owner, bucket);
    }

    const owners = [...byOwner.values()].sort((a, b) => {
      const ia = CURRENT_OWNER_ORDER.indexOf(a.name);
      const ib = CURRENT_OWNER_ORDER.indexOf(b.name);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.name.localeCompare(b.name);
    });
    const totals = owners.reduce((a, row) => ({
      assigned: a.assigned + row.assigned,
      reviewed: a.reviewed + row.reviewed,
      overdue: a.overdue + row.overdue,
    }), { assigned: 0, reviewed: 0, overdue: 0 });
    if (totals.assigned !== totals.reviewed + totals.overdue) {
      throw new Error("Inconsistent EA totals");
    }
    return Response.json({
      ...totals,
      monitoredOwners: owners.length,
      coverage: totals.assigned ? Math.round((totals.reviewed / totals.assigned) * 100) : 0,
      owners,
      today,
      updatedAt: new Date().toISOString(),
      rule: "Seven calendar days since Last Reviewed; blank is overdue; paused, withdrawn and unassigned excluded.",
    }, { headers });
  } catch {
    return Response.json({ error: "Live EA follow-up metrics unavailable" }, { status: 503, headers });
  }
}
