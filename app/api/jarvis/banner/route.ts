import { bannerHTML } from "./banner-template";
import { metricsRequestUrl, renderBanner } from "./render";
import { GET as getMetrics } from "../metrics/route";
import { parseJarvisScope, validateBannerMetrics, type BannerMetrics, type JarvisScope } from "../scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const headers = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self' https://www.campus2care.org; frame-ancestors https://app.notion.com https://www.notion.so https://*.notion.so https://*.notion.site",
};

async function loadMetrics(scope: JarvisScope): Promise<BannerMetrics | null> {
  try {
    // Read the handler in-process so a scoped embed queries only the Notion
    // sources it displays, including on preview hosts that are not production yet.
    const response = await getMetrics(new Request(metricsRequestUrl(scope)));
    if (!response.ok) throw new Error("Metrics unavailable");
    const data: unknown = await response.json();
    if (!validateBannerMetrics(data, scope)) throw new Error("Invalid aggregate response");
    return { ...data, updatedAt: new Date(data.updatedAt).toISOString() };
  } catch {
    // Keep the failure visible instead of substituting a historical count.
    return null;
  }
}

export async function GET(request?: Request): Promise<Response> {
  const scope = parseJarvisScope(request);
  const metrics = await loadMetrics(scope);
  return new Response(renderBanner(bannerHTML, scope, metrics), {
    status: metrics ? 200 : 503,
    headers,
  });
}
