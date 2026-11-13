export const CAMPUSES = ["BU", "BC"] as const;
export type Campus = (typeof CAMPUSES)[number];

export const METRIC_KEYS = ["volunteers", "cleared", "tasks", "research"] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export type JarvisScope = {
  campus: Campus | null;
  metrics: readonly MetricKey[] | null;
};

export type ResearchMetrics = {
  phase: string;
  completed: number;
  total: number;
  inProgress: number;
  confirmed: number;
  pending: number;
  notStarted: number;
  submitted: number;
  checked: number;
};

export type CampusVolunteerMetrics = {
  total: number;
  cleared: number;
};

export type BannerMetrics = {
  totalVolunteers?: number;
  clearedVolunteers?: number;
  dueTasks?: number;
  campuses?: Partial<Record<Campus, CampusVolunteerMetrics>>;
  research?: ResearchMetrics;
  updatedAt: string;
};

const RESEARCH_FIELDS = [
  "completed",
  "total",
  "inProgress",
  "confirmed",
  "pending",
  "notStarted",
  "submitted",
  "checked",
] as const;

const METRIC_LABELS: Record<MetricKey, string> = {
  volunteers: "total volunteers",
  cleared: "cleared volunteers",
  tasks: "tasks due",
  research: "assignment progress",
};

export function campusDisplayName(campus: Campus): string {
  return campus === "BC" ? "Boston College" : "Boston University";
}

export function parseJarvisScope(request?: Request | null): JarvisScope {
  if (!request?.url) return { campus: null, metrics: null };
  try {
    return scopeFromSearchParams(new URL(request.url).searchParams);
  } catch {
    return { campus: null, metrics: null };
  }
}

export function scopeFromSearchParams(params: URLSearchParams): JarvisScope {
  const campus = parseCampus(params.get("campus"));
  const metrics = parseMetrics(params.get("metrics"));
  return { campus, metrics };
}

export function isScoped(scope: JarvisScope): boolean {
  return scope.campus !== null || scope.metrics !== null;
}

export function wantsMetric(scope: JarvisScope, metric: MetricKey): boolean {
  return scope.metrics === null || scope.metrics.includes(metric);
}

export function activeMetrics(scope: JarvisScope): readonly MetricKey[] {
  return scope.metrics ?? METRIC_KEYS;
}

function parseCampus(value: string | null): Campus | null {
  if (value === null) return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === "BU" || normalized === "BC") return normalized;
  return null;
}

function parseMetrics(value: string | null): readonly MetricKey[] | null {
  if (value === null || value.trim() === "") return null;
  const seen = new Set<MetricKey>();
  for (const part of value.split(",")) {
    const key = part.trim().toLowerCase();
    if ((METRIC_KEYS as readonly string[]).includes(key)) seen.add(key as MetricKey);
  }
  if (seen.size === 0 || seen.size === METRIC_KEYS.length) return null;
  return METRIC_KEYS.filter((key) => seen.has(key));
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function campusRow(value: unknown): value is CampusVolunteerMetrics {
  if (!value || typeof value !== "object") return false;
  const row = value as { total?: unknown; cleared?: unknown };
  return isCount(row.total) && isCount(row.cleared) && row.cleared <= row.total;
}

function researchPhase(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 80 && !/[\u0000-\u001f<>]/.test(value);
}

function researchRow(value: unknown): value is ResearchMetrics {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (!researchPhase(row.phase)) return false;
  if (!RESEARCH_FIELDS.every((field) => isCount(row[field]))) return false;
  const completed = row.completed as number;
  const checked = row.checked as number;
  const inProgress = row.inProgress as number;
  const notStarted = row.notStarted as number;
  const submitted = row.submitted as number;
  const confirmed = row.confirmed as number;
  const pending = row.pending as number;
  const total = row.total as number;
  return completed === checked
    && notStarted + inProgress + submitted + checked === total
    && confirmed + pending <= total;
}

export function researchTileDetail(research: ResearchMetrics): string {
  if (research.notStarted === research.total) {
    return `${research.confirmed} confirmed · ${research.pending} pending · not started`;
  }
  return `${research.notStarted} not started · ${research.inProgress} in progress · ${research.submitted} submitted · ${research.checked} checked`;
}

export function validateBannerMetrics(data: unknown, scope: JarvisScope): data is BannerMetrics {
  if (!data || typeof data !== "object") return false;
  const row = data as Record<string, unknown>;
  if (typeof row.updatedAt !== "string" || !Number.isFinite(Date.parse(row.updatedAt))) return false;

  if (!isScoped(scope)) {
    if (!isCount(row.totalVolunteers) || !isCount(row.clearedVolunteers) || !isCount(row.dueTasks)) return false;
    if (!row.campuses || typeof row.campuses !== "object") return false;
    const campuses = row.campuses as Record<string, unknown>;
    if (!CAMPUSES.every((campus) => campusRow(campuses[campus]))) return false;
    const bu = campuses.BU as CampusVolunteerMetrics;
    const bc = campuses.BC as CampusVolunteerMetrics;
    if (row.totalVolunteers !== bu.total + bc.total) return false;
    if (row.clearedVolunteers !== bu.cleared + bc.cleared) return false;
    return researchRow(row.research);
  }

  const metrics = activeMetrics(scope);
  const needsPipeline = metrics.includes("volunteers") || metrics.includes("cleared");
  if (needsPipeline) {
    if (!row.campuses || typeof row.campuses !== "object") return false;
    const campuses = row.campuses as Record<string, unknown>;
    const expected = scope.campus ? [scope.campus] : [...CAMPUSES];
    if (scope.campus && Object.keys(campuses).some((key) => key !== scope.campus)) return false;
    if (!expected.every((campus) => campusRow(campuses[campus]))) return false;
    if (metrics.includes("volunteers")) {
      const sum = expected.reduce((total, campus) => total + (campuses[campus] as CampusVolunteerMetrics).total, 0);
      if (!isCount(row.totalVolunteers) || row.totalVolunteers !== sum) return false;
    }
    if (metrics.includes("cleared")) {
      const sum = expected.reduce((total, campus) => total + (campuses[campus] as CampusVolunteerMetrics).cleared, 0);
      if (!isCount(row.clearedVolunteers) || row.clearedVolunteers !== sum) return false;
    }
  }

  if (!metrics.includes("tasks") && Object.prototype.hasOwnProperty.call(row, "dueTasks")) return false;
  if (metrics.includes("tasks") && !isCount(row.dueTasks)) return false;
  if (!metrics.includes("research") && Object.prototype.hasOwnProperty.call(row, "research")) return false;
  if (metrics.includes("research") && !researchRow(row.research)) return false;
  return true;
}

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

export function scopedBannerCopy(scope: JarvisScope): { eyebrow: string; subtitle: string; signals: string } | null {
  if (!isScoped(scope)) return null;
  const metrics = activeMetrics(scope);
  const campusName = scope.campus ? campusDisplayName(scope.campus) : null;
  const volunteerLabels = metrics
    .filter((metric) => metric === "volunteers" || metric === "cleared")
    .map((metric) => METRIC_LABELS[metric]);
  const orgLabels = metrics
    .filter((metric) => metric === "tasks" || metric === "research")
    .map((metric) => METRIC_LABELS[metric]);
  let subtitle: string;
  if (campusName && orgLabels.length && volunteerLabels.length === 0) {
    subtitle = `Organization-wide ${joinList(orgLabels)}.`;
  } else if (campusName && volunteerLabels.length && orgLabels.length) {
    subtitle = `${campusName} ${joinList(volunteerLabels)}, plus organization-wide ${joinList(orgLabels)}.`;
  } else if (campusName) {
    subtitle = `${campusName} ${joinList(volunteerLabels)}.`;
  } else {
    subtitle = `Campus2Care ${joinList(metrics.map((metric) => METRIC_LABELS[metric]))}.`;
  }
  return {
    eyebrow: campusName ? `${campusName} · Jarvis` : "Campus2Care · Jarvis",
    subtitle,
    signals: campusName ? `${campusName} signals` : "Live signals",
  };
}
