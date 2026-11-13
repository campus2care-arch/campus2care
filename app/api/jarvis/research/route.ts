import { GET as getResearchMetrics } from "./metrics/route";
import { validateResearchPanel } from "./model";
import { renderResearchPanel } from "./render";

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

export async function GET(): Promise<Response> {
  try {
    const response = await getResearchMetrics();
    const data: unknown = await response.json();
    if (!validateResearchPanel(data)) throw new Error("Invalid research panel");
    return new Response(renderResearchPanel(data), { status: 200, headers });
  } catch {
    return new Response("Research panel is temporarily unavailable", {
      status: 503,
      headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
