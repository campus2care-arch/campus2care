import { bannerHTML } from "./banner-template";
import { GET as getMetrics } from "../metrics/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const fields = ["applicationsNotNeeded", "applicationsApproved", "applicationsDrafting", "applicationsNotStarted"] as const;
type Metrics = Record<typeof fields[number], number> & { updatedAt: string };

export async function GET(): Promise<Response> {
  let metrics: Metrics | null = null;
  try {
    const response = await getMetrics();
    if (!response.ok) throw new Error("Metrics unavailable");
    const data = await response.json();
    if (!fields.every(field => Number.isSafeInteger(data[field]) && data[field] >= 0) ||
        typeof data.updatedAt !== "string" || !Number.isFinite(Date.parse(data.updatedAt))) throw new Error("Invalid metrics");
    metrics = { applicationsNotNeeded: data.applicationsNotNeeded, applicationsApproved: data.applicationsApproved,
      applicationsDrafting: data.applicationsDrafting, applicationsNotStarted: data.applicationsNotStarted, updatedAt: new Date(data.updatedAt).toISOString() };
  } catch { /* Leave the unavailable state visible instead of inventing counts. */ }
  let html = bannerHTML.replace("__LOCATIONS_INITIAL_METRICS__", JSON.stringify(metrics));
  if (metrics) for (const field of fields) html = html.replace(`data-metric="${field}">—`, `data-metric="${field}">${metrics[field]}`);
  return new Response(html, { status: metrics ? 200 : 503, headers: {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src https://www.campus2care.org; frame-ancestors https://app.notion.com https://www.notion.so https://*.notion.so https://*.notion.site",
  } });
}
