import { bannerHTML } from "../banner/banner-template";
import { INTEGRATION_NAME, type Access, type PersonCard, type ResearchPanel } from "./model";

function bannerStyle(): string {
  const style = bannerHTML.match(/<style>([\s\S]*?)<\/style>/)?.[1];
  if (!style) throw new Error("Jarvis banner style is missing");
  return style;
}

function bannerLogo(): string {
  const logo = bannerHTML.match(/class="brand-logo" src="(data:image\/png;base64,[^"]+)"/)?.[1];
  if (!logo) throw new Error("Jarvis banner logo is missing");
  return logo;
}

const EXTRA_STYLE = `
.research-shell .copy{max-width:none}
.research-shell .hero{align-items:start}
.research-shell h1{font-size:clamp(26px,3.2vw,40px)}
.metric-value.text{font-size:clamp(15px,1.7vw,22px);letter-spacing:-.04em;line-height:1.15}
.section-label{margin:14px 0 8px;color:#573b3d;font-size:9px;font-weight:950;letter-spacing:.14em;text-transform:uppercase}
.people{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin:0;padding:0;list-style:none}
.person{min-width:0;padding:7px 8px 6px;border:1px solid #f0e4e2;border-radius:10px;background:#fff}
.person-card{display:block;color:var(--red-dark);font-size:8px;font-weight:900;letter-spacing:.06em;text-transform:uppercase}
.person-owner{display:block;margin-top:2px;font-size:12px;font-weight:800}
.person-meta{display:block;margin-top:2px;color:#8b7778;font-size:8px;line-height:1.35}
.person[data-bucket="submitted"],.person[data-bucket="checked"]{background:#fff6f5}
.person[data-bucket="in-progress"]{box-shadow:inset 3px 0 #f5b4b8}
.person[data-bucket="blocked"]{box-shadow:inset 3px 0 var(--red)}
.blockers{margin:0;padding:0;list-style:none;display:grid;gap:4px}
.blockers li{color:#3c3333;font-size:12px;line-height:1.35}
.blockers li:before{content:"•";color:var(--red);font-weight:900;margin-right:6px}
.extra{margin-top:8px;color:#6f6262;font-size:11px;line-height:1.4}
.share{margin-top:10px;color:#8a3b3e;font-size:10px;line-height:1.4}
@media(max-width:760px){.people{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:520px){
  .research-shell .privacy{display:flex;padding:8px 10px}
  .research-shell .brand-sub{display:block;font-size:8px}
  .people{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media(max-height:400px){
  .research-shell .sub,.research-shell .next,.research-shell .people,.research-shell .blockers,.research-shell .section-label{display:block}
  .research-shell .people{display:grid}
}
`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] ?? character
  ));
}

function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

export function updatedLabel(iso: string, live: boolean): string {
  if (!live) return "Live connection pending";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "Live connection pending";
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  return `Updated ${time} ET`;
}

function phaseHeadline(panel: ResearchPanel): string {
  if (panel.phase.access === "ok" && panel.phase.text) return panel.phase.text;
  if (panel.phase.access === "no-access") return "Research status not shared";
  if (panel.phase.access === "unavailable") return "Research status unavailable";
  return "Phase not set";
}

function tileValue(access: Access, value: string, detail: string): { value: string; detail: string; textual: boolean } {
  if (access === "ok") return { value, detail, textual: /[a-z]/i.test(value) && !/^\d/.test(value) };
  if (access === "no-access") return { value: "—", detail: "No access", textual: false };
  if (access === "not-configured") return { value: "—", detail: "Not set", textual: false };
  return { value: "—", detail: "Unavailable", textual: false };
}

function peopleHtml(people: PersonCard[]): string {
  return people.map((person) => {
    const bucket = person.label === "Blocked" ? "blocked" : person.bucket === "notStarted" ? "not-started"
      : person.bucket === "inProgress" ? "in-progress" : person.bucket;
    const roster = person.roster === "pending" ? "Pending acceptance · " : person.roster === "confirmed" ? "" : "Roster unset · ";
    return `<li class="person" data-bucket="${bucket}"><span class="person-card">${escapeHtml(person.card)}</span><span class="person-owner">${escapeHtml(person.owner)}</span><span class="person-meta">${escapeHtml(`${roster}Checker ${person.checker} · ${person.label}`)}</span></li>`;
  }).join("");
}

function blockerHtml(panel: ResearchPanel): string {
  if (panel.blockers.items.length) {
    return panel.blockers.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  }
  if (panel.blockers.access === "no-access") return "<li>No access</li>";
  if (panel.blockers.access === "unavailable") return "<li>Unavailable</li>";
  if (panel.blockers.access === "not-configured") return "<li>Not set</li>";
  return "<li>None right now</li>";
}

function nextText(panel: ResearchPanel): string {
  if (panel.nextAction.access === "ok") return panel.nextAction.text || "Not set";
  if (panel.nextAction.access === "no-access") return "No access";
  if (panel.nextAction.access === "unavailable") return "Unavailable";
  return "Not set";
}

function deliverableLine(panel: ResearchPanel): string {
  const tile = panel.deliverables;
  if (tile.access === "no-access") return "Deliverables · no access";
  if (tile.access === "unavailable") return "Deliverables · unavailable";
  if (tile.access !== "ok" || tile.needsDecision === null || tile.drafts === null) return "";
  return `Deliverables · ${tile.needsDecision} need a decision · ${tile.drafts} drafts`;
}

function updateLine(panel: ResearchPanel): string {
  if (panel.updates.access === "no-access") return "Updates · no access";
  if (panel.updates.access === "unavailable") return "Updates · unavailable";
  if (panel.updates.access !== "ok") return "";
  return panel.updates.latest ? `Latest · ${panel.updates.latest}` : "Updates · none yet";
}

function shareLine(panel: ResearchPanel): string {
  if (!panel.share.length) return "";
  return `Share with the ${INTEGRATION_NAME} integration: ${panel.share.join(", ")}.`;
}

export function renderResearchPanel(panel: ResearchPanel): string {
  const gate = tileValue(
    panel.methodsGate.access,
    panel.methodsGate.complete === null || panel.methodsGate.total === null ? "—" : `${panel.methodsGate.complete}/${panel.methodsGate.total}`,
    "complete",
  );
  const team = tileValue(
    panel.team.access,
    panel.team.confirmed === null ? "—" : String(panel.team.confirmed),
    panel.team.pending === null ? "" : `confirmed · ${panel.team.pending} pending acceptance`,
  );
  const assignment = tileValue(
    panel.assignment.access,
    panel.assignment.checked === null || panel.assignment.total === null ? "—" : `${panel.assignment.checked}/${panel.assignment.total}`,
    panel.assignment.notStarted === null ? "" : `${panel.assignment.notStarted} not started · ${panel.assignment.inProgress} in progress · ${panel.assignment.submitted} submitted · ${panel.assignment.checked} checked`,
  );
  const prospero = tileValue(panel.prospero.access, panel.prospero.text || "Not set", "registration");
  const live = panel.assignment.access === "ok" || panel.methodsGate.access === "ok";
  const feed = panel.assignment.access === "ok" ? "Live" : panel.assignment.access === "no-access" ? "No access" : "Feed unavailable";
  const share = shareLine(panel);
  const setup = panel.phase.access === "not-configured"
    ? "Create a Research Status row titled Current, then set RESEARCH_STATUS_DATA_SOURCE."
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#ffffff">
<meta name="description" content="Campus2Care live research signals">
<title>Research · Campus2Care</title>
<style>${bannerStyle()}${EXTRA_STYLE}</style>
</head>
<body>
<main class="shell research-shell">
  <header class="topbar">
    <div class="brand">
      <span class="logo-wrap"><img class="brand-logo" src="${bannerLogo()}" alt="Campus2Care logo"></span>
      <span class="brand-copy"><span class="brand-name">Campus2Care</span><span class="brand-sub">Leadership operations · Jarvis</span></span>
    </div>
    <div class="privacy"><span class="pulse" aria-hidden="true"></span>LIVE</div>
  </header>
  <section class="hero" aria-labelledby="hero-title">
    <div class="copy">
      <div class="eyebrow">Research · Jarvis</div>
      <h1 id="hero-title">${escapeHtml(phaseHeadline(panel))}</h1>
      <p class="sub">The v1.6 roster, Assignment 1, and the methods gate. Counts only. No grades or scores.</p>
      <section class="telemetry" aria-label="Live Campus2Care research counts" aria-live="polite">
        <div class="telemetry-head"><span class="telemetry-title">Live research signals</span><span class="feed-state" id="feed-state" data-state="${feed === "Live" ? "live" : "offline"}">${escapeHtml(feed)}</span></div>
        <div class="metric-grid" data-count="4">
          <article class="metric"><span class="metric-label">Methods Gate</span><strong class="metric-value" id="gate-value">${escapeHtml(gate.value)}</strong><span class="metric-detail" id="gate-detail">${escapeHtml(gate.detail)}</span><span class="metric-track" aria-hidden="true"></span></article>
          <article class="metric"><span class="metric-label">Team</span><strong class="metric-value" id="team-value">${escapeHtml(team.value)}</strong><span class="metric-detail" id="team-detail">${escapeHtml(team.detail)}</span><span class="metric-track" aria-hidden="true"></span></article>
          <article class="metric"><span class="metric-label">Assignment 1</span><strong class="metric-value" id="assignment-value">${escapeHtml(assignment.value)}</strong><span class="metric-detail" id="assignment-detail">${escapeHtml(assignment.detail)}</span><span class="metric-track" aria-hidden="true"></span></article>
          <article class="metric"><span class="metric-label">PROSPERO</span><strong class="metric-value${prospero.textual ? " text" : ""}" id="prospero-value">${escapeHtml(prospero.value)}</strong><span class="metric-detail" id="prospero-detail">${escapeHtml(prospero.detail)}</span><span class="metric-track" aria-hidden="true"></span></article>
        </div>
        <div class="telemetry-foot"><span><strong id="updated-at">${escapeHtml(updatedLabel(panel.updatedAt, live))}</strong></span><span>Counts only · no grades or scores</span></div>
      </section>
      <div class="section-label" id="people-label">Assignment cards · ${panel.people.length}</div>
      <ol class="people" id="people">${peopleHtml(panel.people)}</ol>
      <div class="section-label">Blockers</div>
      <ul class="blockers" id="blockers">${blockerHtml(panel)}</ul>
      <div class="next"><span class="next-icon" aria-hidden="true">→</span><span><strong>Next:</strong> <span id="next-action">${escapeHtml(nextText(panel))}</span></span></div>
      <p class="extra" id="deliverables-line">${escapeHtml(deliverableLine(panel))}</p>
      <p class="extra" id="updates-line">${escapeHtml(updateLine(panel))}</p>
      <p class="share" id="share-line">${escapeHtml([share, setup].filter(Boolean).join(" "))}</p>
    </div>
    <div class="reactor" role="img" aria-label="Animated Campus2Care control core">
      <span class="orbit outer"></span><span class="orbit mid"></span><span class="core"></span><span class="satellite"></span>
      <span class="reactor-label"><span class="beacon"></span>C2C · Control active</span>
    </div>
  </section>
</main>
<script id="initial-research" type="application/json">${embedJson(panel)}</script>
<script>
(() => {
  const status = document.getElementById("feed-state");
  const updated = document.getElementById("updated-at");
  const initial = JSON.parse(document.getElementById("initial-research").textContent || "null");
  const accessOk = (value) => value === "ok" || value === "no-access" || value === "not-configured" || value === "unavailable";
  const count = (value) => value === null || (Number.isSafeInteger(value) && value >= 0);
  function valid(data) {
    return data && typeof data.updatedAt === "string" && Number.isFinite(Date.parse(data.updatedAt)) &&
      accessOk(data.assignment && data.assignment.access) && accessOk(data.methodsGate && data.methodsGate.access) &&
      count(data.assignment && data.assignment.total) && Array.isArray(data.people) && data.people.length <= 24 &&
      data.people.every((person) => person && typeof person.owner === "string" && person.owner.indexOf("@") === -1);
  }
  function setText(id, value) {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  }
  function headline(data) {
    if (data.phase && data.phase.access === "ok" && data.phase.text) return data.phase.text;
    if (data.phase && data.phase.access === "no-access") return "Research status not shared";
    if (data.phase && data.phase.access === "unavailable") return "Research status unavailable";
    return "Phase not set";
  }
  function stamp(data) {
    const live = data.assignment.access === "ok" || data.methodsGate.access === "ok";
    if (!live) return "Live connection pending";
    const time = new Date(data.updatedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
    return "Updated " + time + " ET";
  }
  function tile(access, value, detail) {
    if (access === "ok") return [value, detail];
    if (access === "no-access") return ["—", "No access"];
    if (access === "not-configured") return ["—", "Not set"];
    return ["—", "Unavailable"];
  }
  function paint(data) {
    setText("hero-title", headline(data));
    const gate = tile(data.methodsGate.access, data.methodsGate.complete + "/" + data.methodsGate.total, "complete");
    const team = tile(data.team.access, String(data.team.confirmed), "confirmed · " + data.team.pending + " pending acceptance");
    const assignment = tile(data.assignment.access, data.assignment.checked + "/" + data.assignment.total,
      data.assignment.notStarted + " not started · " + data.assignment.inProgress + " in progress · " + data.assignment.submitted + " submitted · " + data.assignment.checked + " checked");
    const prospero = tile(data.prospero.access, data.prospero.text || "Not set", "registration");
    setText("gate-value", gate[0]); setText("gate-detail", gate[1]);
    setText("team-value", team[0]); setText("team-detail", team[1]);
    setText("assignment-value", assignment[0]); setText("assignment-detail", assignment[1]);
    setText("prospero-value", prospero[0]); setText("prospero-detail", prospero[1]);
    const people = document.getElementById("people");
    people.replaceChildren();
    data.people.forEach((person) => {
      const item = document.createElement("li");
      item.className = "person";
      const bucket = person.label === "Blocked" ? "blocked" : person.bucket === "notStarted" ? "not-started" : person.bucket === "inProgress" ? "in-progress" : person.bucket;
      item.dataset.bucket = bucket;
      const card = document.createElement("span");
      card.className = "person-card";
      card.textContent = person.card || "Card";
      const owner = document.createElement("span");
      owner.className = "person-owner";
      owner.textContent = person.owner;
      const meta = document.createElement("span");
      meta.className = "person-meta";
      const roster = person.roster === "pending" ? "Pending acceptance · " : person.roster === "confirmed" ? "" : "Roster unset · ";
      meta.textContent = roster + "Checker " + (person.checker || "Unassigned") + " · " + (person.label || "");
      item.append(card, owner, meta);
      people.append(item);
    });
    setText("people-label", "Assignment cards · " + data.people.length);
    const blockers = document.getElementById("blockers");
    blockers.replaceChildren();
    const blockerAccess = data.blockers && data.blockers.access;
    const items = data.blockers && data.blockers.items && data.blockers.items.length ? data.blockers.items
      : [blockerAccess === "no-access" ? "No access" : blockerAccess === "unavailable" ? "Unavailable" : blockerAccess === "ok" ? "None right now" : "Not set"];
    items.forEach((item) => {
      const line = document.createElement("li");
      line.textContent = item;
      blockers.append(line);
    });
    const next = data.nextAction && data.nextAction.access === "ok" ? (data.nextAction.text || "Not set")
      : data.nextAction && data.nextAction.access === "no-access" ? "No access"
      : data.nextAction && data.nextAction.access === "unavailable" ? "Unavailable" : "Not set";
    setText("next-action", next);
    const documents = data.deliverables || {};
    setText("deliverables-line", documents.access === "no-access" ? "Deliverables · no access" : documents.access === "unavailable" ? "Deliverables · unavailable" : documents.access === "ok" ? "Deliverables · " + documents.needsDecision + " need a decision · " + documents.drafts + " drafts" : "");
    const feed = data.updates || {};
    setText("updates-line", feed.access === "no-access" ? "Updates · no access" : feed.access === "unavailable" ? "Updates · unavailable" : feed.access === "ok" ? (feed.latest ? "Latest · " + feed.latest : "Updates · none yet") : "");
    const share = data.share && data.share.length ? "Share with the " + data.integration + " integration: " + data.share.join(", ") + "." : "";
    const setup = data.phase && data.phase.access === "not-configured" ? "Create a Research Status row titled Current, then set RESEARCH_STATUS_DATA_SOURCE." : "";
    setText("share-line", [share, setup].filter(Boolean).join(" "));
    setText("updated-at", stamp(data));
    status.textContent = data.assignment.access === "ok" ? "Live" : data.assignment.access === "no-access" ? "No access" : "Feed unavailable";
    status.dataset.state = data.assignment.access === "ok" ? "live" : "offline";
  }
  async function refresh() {
    try {
      const response = await fetch("/api/jarvis/research/metrics?refresh=" + Date.now(), { cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(20000), headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("Feed unavailable");
      const data = await response.json();
      if (!valid(data)) throw new Error("Feed unavailable");
      paint(data);
    } catch {
      status.textContent = "Feed unavailable";
      status.dataset.state = "offline";
      if (updated.textContent.indexOf("Updated") !== 0) updated.textContent = "Live connection pending";
    }
  }
  if (valid(initial)) paint(initial);
  refresh();
  window.setInterval(refresh, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
})();
</script>
</body>
</html>`;
}
