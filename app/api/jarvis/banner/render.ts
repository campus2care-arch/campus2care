import {
  campusDisplayName,
  isScoped,
  researchTileDetail,
  scopedBannerCopy,
  wantsMetric,
  type BannerMetrics,
  type JarvisScope,
  type MetricKey,
} from "../scope";

function presentMetricCards(html: string, scope: JarvisScope): string {
  if (!scope.metrics) return html;
  const allowed = new Set<string>(scope.metrics);
  const filtered = html.replace(
    /<article class="metric" data-metric-card="(volunteers|cleared|tasks|research)">[\s\S]*?<\/article>/g,
    (article, card: string) => (allowed.has(card) ? article : ""),
  );
  return filtered.replace('class="metric-grid"', `class="metric-grid" data-count="${scope.metrics.length}"`);
}

function applyScopePresentation(html: string, scope: JarvisScope): string {
  let next = presentMetricCards(html, scope);
  const copy = scopedBannerCopy(scope);
  if (!copy) return next;
  next = next
    .replace(/<div class="eyebrow">[^<]*<\/div>/, `<div class="eyebrow">${copy.eyebrow}</div>`)
    .replace(/<p class="sub">[^<]*<\/p>/, `<p class="sub">${copy.subtitle}</p>`)
    .replace(">Live HQ signals<", `>${copy.signals}<`)
    .replace('<div class="next">', '<div class="next" hidden>');
  if (scope.campus) {
    next = next.replace("<title>Jarvis · Campus2Care</title>", `<title>Jarvis · ${campusDisplayName(scope.campus)}</title>`);
  }
  if (scope.campus && wantsMetric(scope, "volunteers")) {
    next = next.replace(
      'id="campus-volunteer-breakdown">BU + BC · live',
      `id="campus-volunteer-breakdown">${campusDisplayName(scope.campus)}`,
    );
  }
  return next;
}

function injectCounts(html: string, metrics: BannerMetrics, scope: JarvisScope): string {
  let next = html;
  const scalar: Array<[MetricKey, "totalVolunteers" | "clearedVolunteers" | "dueTasks"]> = [
    ["volunteers", "totalVolunteers"],
    ["cleared", "clearedVolunteers"],
    ["tasks", "dueTasks"],
  ];
  for (const [metric, field] of scalar) {
    if (!wantsMetric(scope, metric)) continue;
    const value = metrics[field];
    if (typeof value !== "number") continue;
    next = next.replace(`data-metric="${field}">—`, `data-metric="${field}">${value}`);
  }
  if (wantsMetric(scope, "research") && metrics.research) {
    const research = metrics.research;
    next = next
      .replace('data-metric="researchCompleted">—', `data-metric="researchCompleted">${research.completed}`)
      .replace('id="research-total">—', `id="research-total">${research.total}`)
      .replace(
        'id="research-detail">Roster and assignment progress',
        `id="research-detail">${researchTileDetail(research)}`,
      );
  }
  return next;
}

function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function renderBanner(template: string, scope: JarvisScope, metrics: BannerMetrics | null): string {
  const html = applyScopePresentation(template, scope)
    .replace("__JARVIS_SCOPE__", embedJson({ campus: scope.campus, metrics: scope.metrics }))
    .replace("__JARVIS_INITIAL_METRICS__", embedJson(metrics));
  return metrics ? injectCounts(html, metrics, scope) : html;
}

export function metricsRequestUrl(scope: JarvisScope): string {
  const url = new URL("https://www.campus2care.org/api/jarvis/metrics");
  if (!isScoped(scope)) return url.toString();
  if (scope.campus) url.searchParams.set("campus", scope.campus);
  if (scope.metrics) url.searchParams.set("metrics", scope.metrics.join(","));
  return url.toString();
}
