export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// This single embedded chart switches display between the physically separate
// BU and BC Notion pipelines. The existing aggregate endpoint never exposes PII.
const METRICS_URL = "https://www.campus2care.org/api/jarvis/metrics";
const STAGE_NAMES = ["Cleared", "Hospital Onboarding", "Needs Interview", "Needs Placement", "Needs Workshop", "No Stage"] as const;

function validCampusMetrics(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const data = value as { campuses?: Record<string, {total: number; cleared: number; stages: Record<string, number>} > };
  return ["BU", "BC"].every(campus => {
    const row = data.campuses?.[campus];
    return row && Number.isSafeInteger(row.total) && row.total >= 0 &&
      Number.isSafeInteger(row.cleared) && row.cleared >= 0 &&
      STAGE_NAMES.every(stage => Number.isSafeInteger(row.stages?.[stage]) && row.stages[stage] >= 0) &&
      STAGE_NAMES.reduce((total, stage) => total + row.stages[stage], 0) === row.total &&
      row.stages.Cleared === row.cleared;
  });
}

const template = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#ffffff" />
<title>Campus2Care · Volunteer Pipeline</title>
<style>
  :root { color-scheme: light; --ink:#252525; --muted:#858585; --red:#de5450; --line:#eee7e5; }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; width:100%; background:#fff; font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif; color:var(--ink); }
  .wrap { max-width:850px; margin:0 auto; padding:16px 18px 12px; }
  .head { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; }
  h1 { font-size:clamp(19px,3vw,26px); font-weight:780; letter-spacing:-.035em; margin:0; }
  .picker { display:flex; align-items:center; gap:10px; color:#6d6868; font-size:12px; font-weight:700; }
  select { appearance:auto; min-width:172px; max-width:230px; padding:10px 12px; color:#2d2828; font:inherit; font-size:13px; border:1px solid #e5d7d6; border-radius:9px; background:#fffaf9; cursor:pointer; }
  select:focus-visible { outline:3px solid #f5c3c0; outline-offset:2px; }
  .plot { display:flex; align-items:center; justify-content:center; min-height:250px; margin:12px 0 3px; }
  .donut { position:relative; width:min(100%,365px); aspect-ratio:1; }
  svg { display:block; width:100%; height:100%; overflow:visible; }
  .ring { fill:none; stroke-width:32; }
  .center { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; pointer-events:none; }
  .number { font-size:clamp(50px,8vw,76px); font-weight:760; letter-spacing:-.06em; line-height:1; font-variant-numeric:tabular-nums; }
  .totallabel { margin-top:8px; font-size:14px; color:#8b8585; }
  .legend { padding:0; margin:12px auto 0; display:grid; max-width:690px; grid-template-columns:repeat(3,minmax(0,1fr)); gap:11px 14px; list-style:none; }
  .legend li { display:flex; align-items:center; gap:9px; color:#777; font-size:12px; min-width:0; }
  .swatch { width:10px; height:10px; border-radius:3px; flex:none; }
  .legend-label { flex:1; min-width:0; }
  .legend-count { color:#514848; font-variant-numeric:tabular-nums; font-weight:680; }
  .foot { display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px; margin:14px 0 0; padding-top:8px; border-top:1px solid #f2eeec; color:#968989; font-size:10px; }
  #state[data-state="offline"] { color:#b32626; }
  #state[data-state="live"] { color:#888080; }
  @media(max-width:520px) { .wrap { padding:12px 9px; } .legend{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;} .legend li{font-size:11px;} .plot{min-height:210px;} .picker{width:100%;justify-content:space-between;} .donut{width:min(100%,310px);} }
</style>
</head>
<body>
<main class="wrap">
  <div class="head">
    <h1>Volunteer Pipeline</h1>
    <div class="picker"><label for="campus">Campus</label><select id="campus" aria-label="Select campus pipeline"><option value="BU">Boston University (BU)</option><option value="BC">Boston College (BC)</option></select></div>
  </div>
  <section aria-label="Campus stage breakdown">
    <div class="plot">
      <div class="donut">
        <svg viewBox="0 0 400 400" role="img" aria-label="Volunteer pipeline stage breakdown" id="donut-svg">
          <circle cx="200" cy="200" r="142" fill="none" stroke="#eeeeee" stroke-width="32"></circle>
          <g id="segments" transform="rotate(-90 200 200)"></g>
        </svg>
        <div class="center" aria-live="polite"><strong class="number" id="total">—</strong><span class="totallabel">Total</span></div>
      </div>
    </div>
    <ul class="legend" id="legend" aria-label="Volunteer stage counts"></ul>
  </section>
  <div class="foot"><span id="state" data-state="loading">Connecting to live campus records</span><span id="updated">Source: separate BU and BC Notion pipelines</span></div>
</main>
<script type="application/json" id="initial-data">__INITIAL_METRICS__</script>
<script>
(function () {
  "use strict";
  const names = ["Cleared","Hospital Onboarding","Needs Interview","Needs Placement","Needs Workshop","No Stage"];
  const colors = ["#eb7067","#f09b94","#f5b6b0","#fad3cf","#fbe9e6","#e8e8e8"];
  const selector = document.getElementById("campus");
  const total = document.getElementById("total");
  const segments = document.getElementById("segments");
  const legend = document.getElementById("legend");
  const state = document.getElementById("state");
  const updated = document.getElementById("updated");
  const svg = document.getElementById("donut-svg");
  const ns = "http://www.w3.org/2000/svg";
  const circumference = Math.PI * 2 * 142;
  const isCount = value => Number.isSafeInteger(value) && value >= 0;
  let current = null;

  function valid(data) {
    return data && data.campuses && ["BU", "BC"].every(key => {
      const campus = data.campuses[key];
      return campus && isCount(campus.total) && isCount(campus.cleared) &&
        names.every(name => isCount(campus.stages && campus.stages[name])) &&
        names.reduce((sum, name) => sum + campus.stages[name], 0) === campus.total &&
        campus.cleared === campus.stages.Cleared;
    }) && typeof data.updatedAt === "string" && Number.isFinite(Date.parse(data.updatedAt));
  }

  function draw() {
    if (!current) return;
    const key = selector.value === "BC" ? "BC" : "BU";
    const stats = current.campuses[key];
    total.textContent = stats.total.toLocaleString("en-US");
    svg.setAttribute("aria-label", (key === "BU" ? "Boston University" : "Boston College") +
      " volunteer pipeline: " + stats.total + " named records");
    segments.replaceChildren();
    legend.replaceChildren();
    let offset = 0;
    names.forEach((name, i) => {
      const count = stats.stages[name];
      if (stats.total && count) {
        const length = circumference * count / stats.total;
        const arc = document.createElementNS(ns, "circle");
        arc.setAttribute("cx", "200");
        arc.setAttribute("cy", "200");
        arc.setAttribute("r", "142");
        arc.setAttribute("class", "ring");
        arc.setAttribute("stroke", colors[i]);
        arc.setAttribute("stroke-dasharray", String(Math.max(0, length - 1.5)) + " " + String(circumference));
        arc.setAttribute("stroke-dashoffset", String(-offset));
        const hint = document.createElementNS(ns, "title");
        hint.textContent = name + ": " + count;
        arc.appendChild(hint);
        segments.appendChild(arc);
        offset += length;
      }
      const li = document.createElement("li");
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.backgroundColor = colors[i];
      const label = document.createElement("span");
      label.className = "legend-label";
      label.textContent = name;
      const quantity = document.createElement("span");
      quantity.className = "legend-count";
      quantity.textContent = count.toLocaleString("en-US");
      li.append(swatch,label,quantity);
      legend.appendChild(li);
    });
  }

  async function refresh() {
    try {
      const response = await fetch("https://www.campus2care.org/api/jarvis/metrics?chart=" + Date.now(), {
        cache: "no-store", credentials:"omit", headers: {Accept:"application/json"}, signal: AbortSignal.timeout(20000)
      });
      if (!response.ok) throw new Error("Live data unavailable");
      const value = await response.json();
      if (!valid(value)) throw new Error("Invalid stage counts");
      current = value;
      draw();
      state.textContent = "Live from Notion · " + (selector.value === "BU" ? "BU" : "BC") + " only";
      state.dataset.state = "live";
      updated.textContent = "Updated " + new Date(value.updatedAt).toLocaleTimeString("en-US", {hour:"numeric",minute:"2-digit",timeZone:"America/New_York"}) + " ET";
    } catch {
      state.textContent = current ? "Unable to refresh · last verified values" : "Live data temporarily unavailable";
      state.dataset.state = "offline";
    }
  }

  selector.addEventListener("change", function () {
    draw();
    if (current && state.dataset.state === "live") state.textContent = "Live from Notion · " + (selector.value === "BU" ? "BU" : "BC") + " only";
  });
  try {
    const initial = JSON.parse(document.getElementById("initial-data").textContent || "null");
    if (valid(initial)) {
      current = initial;
      draw();
      state.textContent = "Live from Notion · BU only";
      state.dataset.state = "live";
      updated.textContent = "Updated " + new Date(initial.updatedAt).toLocaleTimeString("en-US", {hour:"numeric",minute:"2-digit",timeZone:"America/New_York"}) + " ET";
    }
  } catch {}
  refresh();
  window.setInterval(refresh, 60000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
})();
</script>
</body>
</html>`;

export async function GET(): Promise<Response> {
  let initial: unknown = null;
  try {
    const result = await fetch(METRICS_URL, {
      cache:"no-store",
      signal: AbortSignal.timeout(15000),
      headers:{Accept:"application/json"},
    });
    if (!result.ok) throw new Error("Metrics unavailable");
    const data: unknown = await result.json();
    if (validCampusMetrics(data)) initial = data;
  } catch {
    // Render a recoverable shell, never display invented or cached record counts.
  }
  const html = template.replace("__INITIAL_METRICS__", JSON.stringify(initial).replace(/</g, "\\u003c"));
  return new Response(html, {
    status:200,
    headers: {
      "Content-Type":"text/html; charset=utf-8",
      "Cache-Control":"no-store",
      "X-Robots-Tag":"noindex, nofollow, noarchive",
      "X-Content-Type-Options":"nosniff",
      "Referrer-Policy":"no-referrer",
      "Content-Security-Policy":"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src https://www.campus2care.org; frame-ancestors https://app.notion.com https://www.notion.so https://*.notion.so https://*.notion.site",
    }
  });
}
