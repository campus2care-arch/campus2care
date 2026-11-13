// Research panel counts. Leadership rows and anything that looks like a grade,
// score, or email are never included in the payload.
//
// Phase, PROSPERO, blockers, and the next action are not columns on the
// assignment or methods-gate databases. They come from one row in a database
// the founder creates, named Research Status:
//
//   Name (title)     Current
//   Phase (text)     Protocol finalization · pre-registration
//   PROSPERO (text)  Unresolved
//   Next action (text)
//   Blockers (text)  one blocker per line
//
// Share that database, plus any tile that renders "No access", with the
// Notion integration "Availability Form". Then set the production env
// RESEARCH_STATUS_DATA_SOURCE to the data source id (a database id is also
// accepted; the loader resolves it).

export const METHODS_GATE_SOURCE = "815aed83-1be3-42bf-836d-3e978e0306ce";
export const ASSIGNMENTS_SOURCE = "c1ebdb3e-649c-4c5a-9ed2-e1099ac673ce";
export const DELIVERABLES_SOURCE = "417d6c55-a9de-8150-821d-000bdb691c3d";
export const UPDATES_SOURCE = "417d6c55-a9de-8190-bf3b-000b2a6e76e9";
export const STATUS_ENV = "RESEARCH_STATUS_DATA_SOURCE";
export const INTEGRATION_NAME = "Availability Form";
export const METHODS_GATE_COMPLETE = new Set(["Complete", "Not applicable (approved)"]);

export type Access = "ok" | "no-access" | "not-configured" | "unavailable";
export type AssignmentBucket = "notStarted" | "inProgress" | "submitted" | "checked";

export type NotionProperty = {
  title?: Array<{ plain_text?: string }>;
  rich_text?: Array<{ plain_text?: string }>;
  select?: { name?: string } | null;
  status?: { name?: string } | null;
  formula?: { string?: string } | null;
  email?: string | null;
  created_time?: string;
  date?: { start?: string; end?: string | null } | null;
};

export type NotionPage = {
  properties?: Record<string, NotionProperty>;
  in_trash?: boolean;
  is_archived?: boolean;
  archived?: boolean;
  created_time?: string;
  last_edited_time?: string;
};

export type SourceResult = {
  access: Access;
  pages: NotionPage[];
};

export type PersonCard = {
  card: string;
  owner: string;
  checker: string;
  bucket: AssignmentBucket;
  label: string;
  roster: "confirmed" | "pending" | "other";
};

export type TextTile = {
  access: Access;
  text: string | null;
};

export type ResearchPanel = {
  updatedAt: string;
  integration: string;
  phase: TextTile;
  prospero: TextTile;
  nextAction: TextTile;
  blockers: { access: Access; items: string[] };
  methodsGate: { access: Access; complete: number | null; total: number | null };
  team: { access: Access; confirmed: number | null; pending: number | null };
  assignment: {
    access: Access;
    notStarted: number | null;
    inProgress: number | null;
    submitted: number | null;
    checked: number | null;
    total: number | null;
  };
  people: PersonCard[];
  deliverables: { access: Access; needsDecision: number | null; drafts: number | null };
  updates: { access: Access; latest: string | null };
  share: string[];
};

const SENSITIVE = /\b(grades?|scores?|gpa|rubric|points)\b|\b\d{1,3}\s*\/\s*(?:100|10)\b|\b\d{1,3}(?:\.\d+)?\s*%/i;
const UUID = /^[0-9a-f]{32}$/i;

export function propertyText(property?: NotionProperty): string {
  if (!property) return "";
  return (
    property.select?.name ??
    property.status?.name ??
    property.formula?.string ??
    property.email ??
    property.title?.map((part) => part.plain_text ?? "").join("") ??
    property.rich_text?.map((part) => part.plain_text ?? "").join("") ??
    ""
  ).trim();
}

export function normalizeSourceId(value: string | undefined | null): string | null {
  if (!value) return null;
  const compact = value.trim().replace(/-/g, "");
  if (!UUID.test(compact)) return null;
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`.toLowerCase();
}

export function researchStatusId(env: NodeJS.ProcessEnv = process.env): string | null {
  return normalizeSourceId(env[STATUS_ENV]);
}

function live(page: NotionPage): boolean {
  return !page.in_trash && !page.is_archived && !page.archived;
}

function cleanText(value: string, max: number): string | null {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || text.length > 400) return null;
  if (SENSITIVE.test(text) || text.includes("@") || /[<>]/.test(text) || /[\u0000-\u001f]/.test(text)) return null;
  return text.slice(0, max);
}

function pageTitle(page: NotionPage): string {
  const properties = page.properties ?? {};
  if (properties.Name) {
    const named = propertyText(properties.Name);
    if (named) return named;
  }
  for (const property of Object.values(properties)) {
    if (property?.title) {
      const title = propertyText(property);
      if (title) return title;
    }
  }
  return "";
}

function isLeadership(page: NotionPage): boolean {
  const roster = propertyText(page.properties?.["Roster Status"]);
  if (roster === "Leadership") return true;
  return /^Leadership\s*\|/i.test(pageTitle(page) || propertyText(page.properties?.Assignment));
}

function displayName(value: string): string | null {
  const named = value.match(/^([^()]+?)\s*\(([^)]*)\)\s*(.*)$/);
  const text = named ? `${named[1].trim()} ${named[3].trim()}`.trim() : value.trim();
  return cleanText(text, 48);
}

function checkerName(value: string): string | null {
  const lead = value.split(/[→(]/)[0] ?? "";
  return displayName(lead);
}

function bucketFor(status: string): { bucket: AssignmentBucket; label: string } {
  if (status === "Blocked / escalation") return { bucket: "inProgress", label: "Blocked" };
  if (status === "Needs supervisor review") return { bucket: "submitted", label: "Submitted" };
  if (status === "Approved as training complete") return { bucket: "checked", label: "Checked" };
  if (status === "In preparation") return { bucket: "inProgress", label: "In progress" };
  if (status === "" || status === "Not started" || status === "Proposed" || status === "Acceptance confirmed; kickoff pending" || status === "Ready for preparatory work") {
    return { bucket: "notStarted", label: "Not started" };
  }
  return { bucket: "inProgress", label: "In progress" };
}

function rosterOf(value: string): PersonCard["roster"] {
  if (value === "Accepted") return "confirmed";
  if (value === "Pending written acceptance") return "pending";
  return "other";
}

export type AssignmentSnapshot = {
  confirmed: number;
  pending: number;
  notStarted: number;
  inProgress: number;
  submitted: number;
  checked: number;
  total: number;
  people: PersonCard[];
  blocked: string[];
};

export function summarizeAssignments(pages: NotionPage[]): AssignmentSnapshot {
  const people: PersonCard[] = [];
  for (const page of pages) {
    if (!live(page) || isLeadership(page)) continue;
    const properties = page.properties ?? {};
    const status = propertyText(properties.Status);
    const { bucket, label } = bucketFor(status);
    const owner = displayName(propertyText(properties["Proposed Owner"])) ?? "Team member";
    const checker = checkerName(propertyText(properties["Second Checker"])) ?? "Unassigned";
    const card = cleanText(propertyText(properties.Card), 24) ?? "Card";
    people.push({
      card,
      owner,
      checker,
      bucket,
      label,
      roster: rosterOf(propertyText(properties["Roster Status"])),
    });
  }
  people.sort((a, b) => a.card.localeCompare(b.card, "en", { numeric: true }) || a.owner.localeCompare(b.owner, "en"));
  const shown = people.slice(0, 24);
  const count = (bucket: AssignmentBucket) => shown.filter((person) => person.bucket === bucket).length;
  return {
    confirmed: shown.filter((person) => person.roster === "confirmed").length,
    pending: shown.filter((person) => person.roster === "pending").length,
    notStarted: count("notStarted"),
    inProgress: count("inProgress"),
    submitted: count("submitted"),
    checked: count("checked"),
    total: shown.length,
    people: shown,
    blocked: shown.filter((person) => person.label === "Blocked").map((person) => `Blocked: ${person.owner}`),
  };
}

export function assignmentMetrics(pages: NotionPage[], phase: string) {
  const snapshot = summarizeAssignments(pages);
  return {
    phase,
    completed: snapshot.checked,
    total: snapshot.total,
    inProgress: snapshot.inProgress,
    confirmed: snapshot.confirmed,
    pending: snapshot.pending,
    notStarted: snapshot.notStarted,
    submitted: snapshot.submitted,
    checked: snapshot.checked,
  };
}

function editedAt(page: NotionPage): number {
  const value = Date.parse(page.last_edited_time || page.created_time || "");
  return Number.isFinite(value) ? value : 0;
}

function currentStatusRow(pages: NotionPage[]): NotionPage | null {
  const rows = pages.filter(live);
  const current = rows.filter((page) => pageTitle(page).toLowerCase() === "current");
  const pool = current.length ? current : rows.length === 1 ? rows : [];
  if (!pool.length) return null;
  return pool.sort((a, b) => editedAt(b) - editedAt(a))[0] ?? null;
}

function field(page: NotionPage | null, name: string): string {
  if (!page) return "";
  return propertyText(page.properties?.[name]);
}

export function readStatusPhase(pages: NotionPage[]): string {
  const row = currentStatusRow(pages);
  const phase = cleanText(field(row, "Phase"), 80) || cleanText(pageTitle(row ?? {}), 80);
  if (!phase || phase.toLowerCase() === "current") return "unset";
  return phase;
}

function blockerLines(page: NotionPage | null): string[] {
  if (!page) return [];
  const raw = page.properties?.Blockers?.rich_text?.map((part) => part.plain_text ?? "").join("")
    || propertyText(page.properties?.Blockers);
  const items: string[] = [];
  for (const line of raw.split(/\n+/)) {
    const text = cleanText(line.replace(/^[-•*\d.)\s]+/, ""), 160);
    if (text && !items.includes(text)) items.push(text);
  }
  return items.slice(0, 5);
}

export function countMethodsGate(pages: NotionPage[]): { complete: number; total: number } {
  const rows = pages.filter(live);
  const complete = rows.filter((page) => METHODS_GATE_COMPLETE.has(propertyText(page.properties?.Status))).length;
  return { complete, total: rows.length };
}

function countDeliverables(pages: NotionPage[]): { needsDecision: number; drafts: number } {
  let needsDecision = 0;
  let drafts = 0;
  for (const page of pages) {
    if (!live(page)) continue;
    const status = propertyText(page.properties?.Status);
    if (status === "Needs Andrew decision") needsDecision += 1;
    if (status === "Draft for Andrew" || status === "Draft email: NOT SENT") drafts += 1;
  }
  return { needsDecision, drafts };
}

function updateTime(page: NotionPage): number {
  const when = page.properties?.When?.date?.start;
  const logged = page.properties?.Logged?.created_time;
  const value = Date.parse(when || logged || page.created_time || "");
  return Number.isFinite(value) ? value : 0;
}

function latestUpdate(pages: NotionPage[]): string | null {
  const rows = pages.filter(live).sort((a, b) => updateTime(b) - updateTime(a));
  for (const page of rows) {
    const title = cleanText(pageTitle(page), 140);
    if (title) return title;
  }
  return null;
}

function textTile(access: Access, text: string | null): TextTile {
  return { access, text: access === "ok" ? text : null };
}

export function buildResearchPanel(input: {
  updatedAt: string;
  assignments: SourceResult;
  methodsGate: SourceResult;
  status: SourceResult;
  deliverables: SourceResult;
  updates: SourceResult;
}): ResearchPanel {
  const assignments = input.assignments.access === "ok" ? summarizeAssignments(input.assignments.pages) : null;
  const gate = input.methodsGate.access === "ok" ? countMethodsGate(input.methodsGate.pages) : null;
  const statusRow = input.status.access === "ok" ? currentStatusRow(input.status.pages) : null;
  const phase = input.status.access === "ok" ? readStatusPhase(input.status.pages) : "unset";
  const prospero = cleanText(field(statusRow, "PROSPERO"), 40);
  const nextAction = cleanText(field(statusRow, "Next action"), 180);
  const blockers = input.status.access === "ok" ? blockerLines(statusRow) : [];
  for (const line of assignments?.blocked ?? []) {
    if (!blockers.includes(line)) blockers.push(line);
  }
  const deliverables = input.deliverables.access === "ok" ? countDeliverables(input.deliverables.pages) : null;
  const share: string[] = [];
  if (input.methodsGate.access === "no-access") share.push("Methods Gate Items (v1.6)");
  if (input.assignments.access === "no-access") share.push("Student Search Preparation | v1.6 Assignments");
  if (input.status.access === "no-access") share.push("Research Status");
  if (input.deliverables.access === "no-access") share.push("Research Deliverables");
  if (input.updates.access === "no-access") share.push("Research Updates");

  return {
    updatedAt: input.updatedAt,
    integration: INTEGRATION_NAME,
    phase: textTile(input.status.access, phase === "unset" ? null : phase),
    prospero: textTile(input.status.access, prospero),
    nextAction: textTile(input.status.access, nextAction),
    blockers: { access: input.status.access, items: blockers.slice(0, 6) },
    methodsGate: {
      access: input.methodsGate.access,
      complete: gate?.complete ?? null,
      total: gate?.total ?? null,
    },
    team: {
      access: input.assignments.access,
      confirmed: assignments?.confirmed ?? null,
      pending: assignments?.pending ?? null,
    },
    assignment: {
      access: input.assignments.access,
      notStarted: assignments?.notStarted ?? null,
      inProgress: assignments?.inProgress ?? null,
      submitted: assignments?.submitted ?? null,
      checked: assignments?.checked ?? null,
      total: assignments?.total ?? null,
    },
    people: assignments?.people ?? [],
    deliverables: {
      access: input.deliverables.access,
      needsDecision: deliverables?.needsDecision ?? null,
      drafts: deliverables?.drafts ?? null,
    },
    updates: {
      access: input.updates.access,
      latest: input.updates.access === "ok" ? latestUpdate(input.updates.pages) : null,
    },
    share,
  };
}

function isAccess(value: unknown): value is Access {
  return value === "ok" || value === "no-access" || value === "not-configured" || value === "unavailable";
}

function isCountOrNull(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

export function validateResearchPanel(data: unknown): data is ResearchPanel {
  if (!data || typeof data !== "object") return false;
  const row = data as ResearchPanel;
  if (typeof row.updatedAt !== "string" || !Number.isFinite(Date.parse(row.updatedAt))) return false;
  if (row.integration !== INTEGRATION_NAME) return false;
  if (!isAccess(row.phase?.access) || !isAccess(row.prospero?.access) || !isAccess(row.nextAction?.access)) return false;
  if (!isAccess(row.blockers?.access) || !Array.isArray(row.blockers.items)) return false;
  if (!row.blockers.items.every((item) => typeof item === "string" && item.length <= 160 && !item.includes("@"))) return false;
  if (!isAccess(row.methodsGate?.access) || !isCountOrNull(row.methodsGate.complete) || !isCountOrNull(row.methodsGate.total)) return false;
  if (!isAccess(row.team?.access) || !isCountOrNull(row.team.confirmed) || !isCountOrNull(row.team.pending)) return false;
  if (!isAccess(row.assignment?.access)) return false;
  const assignment = row.assignment;
  if (![assignment.notStarted, assignment.inProgress, assignment.submitted, assignment.checked, assignment.total].every(isCountOrNull)) return false;
  if (assignment.access === "ok") {
    const numbers = [assignment.notStarted, assignment.inProgress, assignment.submitted, assignment.checked, assignment.total];
    if (numbers.some((value) => value === null)) return false;
    if ((assignment.notStarted ?? 0) + (assignment.inProgress ?? 0) + (assignment.submitted ?? 0) + (assignment.checked ?? 0) !== assignment.total) return false;
  }
  if (!Array.isArray(row.people) || row.people.length > 24) return false;
  if (!row.people.every((person) => typeof person.owner === "string" && !person.owner.includes("@") && person.owner.length <= 48)) return false;
  if (!isAccess(row.deliverables?.access) || !isAccess(row.updates?.access)) return false;
  if (typeof row.updates.latest === "string" && (row.updates.latest.includes("@") || SENSITIVE.test(row.updates.latest))) return false;
  return Array.isArray(row.share);
}
