import { bannerHTML } from "./banner-template";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const METRICS_URL = "https://www.campus2care.org/api/jarvis/metrics";
const fields = ["totalVolunteers", "clearedVolunteers", "dueTasks"] as const;

export async function GET(): Promise<Response> {
  let metrics: { totalVolunteers: number; clearedVolunteers: number; dueTasks: number; research: {phase: string; completed: number; total: number; inProgress: number}; updatedAt: string } | null = null;
  try {
    const response = await fetch(METRICS_URL, {
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("Metrics unavailable");
    const data = await response.json();
    if (!fields.every(field => Number.isSafeInteger(data[field]) && data[field] >= 0) ||
        !data.research || data.research.phase !== "orientation" ||
        ![data.research.completed, data.research.total, data.research.inProgress].every(value => Number.isSafeInteger(value) && value >= 0) ||
        data.research.completed + data.research.inProgress > data.research.total ||
        typeof data.updatedAt !== "string" || !Number.isFinite(Date.parse(data.updatedAt))) {
      throw new Error("Invalid aggregate response");
    }
    metrics = {
      totalVolunteers: data.totalVolunteers,
      clearedVolunteers: data.clearedVolunteers,
      dueTasks: data.dueTasks,
      research: {phase: "orientation", completed: data.research.completed, total: data.research.total, inProgress: data.research.inProgress},
      updatedAt: new Date(data.updatedAt).toISOString(),
    };
  } catch {
    // Keep the failure visible instead of substituting a historical count.
  }
  let html = bannerHTML.replace("__JARVIS_INITIAL_METRICS__", JSON.stringify(metrics));
  if (metrics) {
    for (const field of fields) {
      html = html.replace(`data-metric="${field}">—`, `data-metric="${field}">${metrics[field]}`);
    }
    html = html.replace('data-metric="researchCompleted">—', `data-metric="researchCompleted">${metrics.research.completed}`)
      .replace('id="research-total">—', `id="research-total">${metrics.research.total}`)
      .replace('id="research-detail">Completion status', `id="research-detail">${metrics.research.inProgress} in progress · ${metrics.research.completed} complete`);
  }
  return new Response(html, {
    status: metrics ? 200 : 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src https://www.campus2care.org; frame-ancestors https://app.notion.com https://www.notion.so https://*.notion.so https://*.notion.site",
    },
  });
}
