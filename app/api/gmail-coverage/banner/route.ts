import { bannerHTML } from "./banner-template";
import { GET as getMetrics } from "../metrics/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
type Metrics = { openShifts: number; scheduledShifts: number; reviewNeeded: number; undatedRecords: number; weekStart: string; weekEnd: string; timeZone: string; updatedAt: string };
export async function GET(): Promise<Response> {
  let metrics: Metrics | null = null;
  try {
    const response = await getMetrics();
    if (!response.ok) throw new Error("Metrics unavailable");
    const data = await response.json();
    if (!["openShifts", "scheduledShifts", "reviewNeeded", "undatedRecords"].every(key => Number.isSafeInteger(data[key]) && data[key] >= 0) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(data.weekStart) || !/^\d{4}-\d{2}-\d{2}$/.test(data.weekEnd) ||
      data.timeZone !== "America/New_York" || typeof data.updatedAt !== "string" || !Number.isFinite(Date.parse(data.updatedAt))) throw new Error("Invalid metrics");
    metrics = { openShifts: data.openShifts, scheduledShifts: data.scheduledShifts, reviewNeeded: data.reviewNeeded,
      undatedRecords: data.undatedRecords, weekStart: data.weekStart, weekEnd: data.weekEnd, timeZone: "America/New_York", updatedAt: new Date(data.updatedAt).toISOString() };
  } catch { /* Show unavailable instead of substituting zeros or a historical snapshot. */ }
  let html = bannerHTML.replace("__GMAIL_INITIAL_METRICS__", JSON.stringify(metrics));
  if (metrics) {
    for (const field of ["openShifts", "scheduledShifts"] as const) html = html.replace(`data-metric="${field}">—`, `data-metric="${field}">${metrics[field]}`);
    const date = (value: string) => new Date(value + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
    html = html.replace('id="week-range">Current week · Eastern · through Sunday', `id="week-range">${date(metrics.weekStart)}–${date(metrics.weekEnd)}, ${metrics.weekEnd.slice(0,4)} · Mon–Sun · Eastern`);
  }
  return new Response(html, { status: metrics ? 200 : 503, headers: {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src https://www.campus2care.org; frame-ancestors https://app.notion.com https://www.notion.so https://*.notion.so https://*.notion.site",
  } });
}
