import { bannerHTML } from "./template";
import { GET as readMetrics } from "../metrics/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Owner = { name: string; assigned: number; reviewed: number; overdue: number };
type Metrics = {
  assigned: number; reviewed: number; overdue: number;
  coverage: number; monitoredOwners: number;
  owners: Owner[]; today: string; updatedAt: string;
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character
  );
}
function numeric(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
function isValid(m: Metrics): boolean {
  return numeric(m.assigned) && numeric(m.reviewed) && numeric(m.overdue) &&
    m.assigned === m.reviewed + m.overdue &&
    numeric(m.coverage) && m.coverage <= 100 &&
    numeric(m.monitoredOwners) &&
    Array.isArray(m.owners) && m.owners.length === m.monitoredOwners &&
    typeof m.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(m.today) &&
    Number.isFinite(Date.parse(m.updatedAt)) &&
    m.owners.every(owner =>
      typeof owner.name === "string" && owner.name.length <= 70 &&
      numeric(owner.assigned) && numeric(owner.reviewed) && numeric(owner.overdue) &&
      owner.assigned === owner.reviewed + owner.overdue
    ) &&
    m.owners.reduce((sum, o) => sum + o.assigned, 0) === m.assigned;
}

function ownerRows(owners: Owner[]): string {
  return owners.map((o, index) => {
    const percent = o.assigned ? Math.min(100, 100 * o.reviewed / o.assigned) : 0;
    const good = o.assigned > 0 && o.reviewed === o.assigned ? " good" : "";
    return `<div class="row" style="animation-delay:${Math.min(index, 15) * 0.055 + .55}s">
<div class="name">${escapeHtml(o.name)}</div>
<div class="thin"><div class="fill${good}" style="--fill:${percent.toFixed(1)}%"></div></div>
<div class="count">${o.reviewed} / ${o.assigned}</div></div>`;
  }).join("");
}

export async function GET(): Promise<Response> {
  let m: Metrics | null = null;
  try {
    const res = await readMetrics();
    if (!res.ok) throw new Error("Live metrics unavailable");
    const value = await res.json() as Metrics;
    if (!isValid(value)) throw new Error("Invalid live metrics");
    m = value;
  } catch {
    // Never silently substitute made-up historical or sample numbers.
  }

  const labels: Record<string, string> = m ? {
    "__AS_OF__": `LIVE · ${escapeHtml(m.today)}`,
    "__COVERAGE__": String(m.coverage),
    "__COVERAGE_LABEL__": `${m.coverage}%`,
    "__REVIEW_FRACTION__": `${m.reviewed} / ${m.assigned}`,
    "__ASSIGNED__": String(m.assigned),
    "__OWNERS__": String(m.monitoredOwners),
    "__OVERDUE__": String(m.overdue),
    "__OWNER_ROWS__": ownerRows(m.owners),
    "__UPDATED_AT__": "LIVE FROM NOTION",
    "__ERROR_HIDDEN__": "hidden",
  } : {
    "__AS_OF__": "NOTION CONNECTION UNAVAILABLE",
    "__COVERAGE__": "0",
    "__COVERAGE_LABEL__": "—",
    "__REVIEW_FRACTION__": "— / —",
    "__ASSIGNED__": "—",
    "__OWNERS__": "—",
    "__OVERDUE__": "—",
    "__OWNER_ROWS__": "",
    "__UPDATED_AT__": "NO LIVE DATA",
    "__ERROR_HIDDEN__": "",
  };
  let html = bannerHTML;
  for (const [key, value] of Object.entries(labels)) {
    html = html.replace(key, value);
  }
  return new Response(html, {
    status: m ? 200 : 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors https://app.notion.com https://www.notion.so https://*.notion.so https://*.notion.site",
    },
  });
}
