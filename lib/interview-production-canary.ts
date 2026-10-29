import type { Campus } from "./interview-notion-contract";

type Settings = Record<string, string | undefined>;

function environment(): Settings {
  return {
    VERCEL_ENV: process.env["VERCEL_ENV"],
    INTERVIEW_DATA_ENV: process.env["INTERVIEW_DATA_ENV"],
    INTERVIEW_PRODUCTION_ENABLED: process.env["INTERVIEW_PRODUCTION_ENABLED"],
    INTERVIEW_BOOKING_ENABLED: process.env["INTERVIEW_BOOKING_ENABLED"],
    INTERVIEW_PRODUCTION_CANARY_ENABLED: process.env["INTERVIEW_PRODUCTION_CANARY_ENABLED"],
    INTERVIEW_OUTREACH_ENABLED: process.env["INTERVIEW_OUTREACH_ENABLED"],
    INTERVIEW_PRODUCTION_ENROLLMENT_ENABLED: process.env["INTERVIEW_PRODUCTION_ENROLLMENT_ENABLED"],
    INTERVIEW_CALENDAR_WRITES_ENABLED: process.env["INTERVIEW_CALENDAR_WRITES_ENABLED"],
    INTERVIEW_GMAIL_SENDS_ENABLED: process.env["INTERVIEW_GMAIL_SENDS_ENABLED"],
    INTERVIEW_NOTION_WRITES_ENABLED: process.env["INTERVIEW_NOTION_WRITES_ENABLED"],
    INTERVIEW_OUTBOX_WORKER_ENABLED: process.env["INTERVIEW_OUTBOX_WORKER_ENABLED"],
    INTERVIEW_PRODUCTION_WORKER_ADAPTER_READY: process.env["INTERVIEW_PRODUCTION_WORKER_ADAPTER_READY"],
    INTERVIEW_PRODUCTION_CANARY_EMAILS: process.env["INTERVIEW_PRODUCTION_CANARY_EMAILS"],
    INTERVIEW_PRODUCTION_CANARY_PAGE_IDS: process.env["INTERVIEW_PRODUCTION_CANARY_PAGE_IDS"],
    INTERVIEW_DATABASE_URL: process.env["INTERVIEW_DATABASE_URL"],
    INTERVIEW_DATABASE_HOST: process.env["INTERVIEW_DATABASE_HOST"],
  };
}

export function productionCanaryConfig(input?: Settings) {
  const env = input ?? environment();
  if (env.VERCEL_ENV !== "production" || env.INTERVIEW_DATA_ENV !== "production" ||
      env.INTERVIEW_PRODUCTION_ENABLED !== "true" ||
      env.INTERVIEW_BOOKING_ENABLED !== "true" ||
      env.INTERVIEW_PRODUCTION_CANARY_ENABLED !== "true" ||
      env.INTERVIEW_OUTREACH_ENABLED !== "false" ||
      env.INTERVIEW_PRODUCTION_ENROLLMENT_ENABLED !== "false" ||
      env.INTERVIEW_PRODUCTION_WORKER_ADAPTER_READY !== "true") {
    throw new Error("interview_production_canary_disabled");
  }
  // Never permit a reservation whose event cannot be processed by a worker.
  for (const key of [
    "INTERVIEW_CALENDAR_WRITES_ENABLED", "INTERVIEW_GMAIL_SENDS_ENABLED",
    "INTERVIEW_NOTION_WRITES_ENABLED", "INTERVIEW_OUTBOX_WORKER_ENABLED",
  ]) {
    if (env[key] !== "true") throw new Error("interview_production_providers_unready");
  }
  const raw = env.INTERVIEW_DATABASE_URL ?? "";
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("interview_production_database_invalid"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname.endsWith(".neon.tech") ||
      url.hostname !== env.INTERVIEW_DATABASE_HOST ||
      !url.username || !url.password || url.pathname.length < 2 ||
      url.searchParams.get("sslmode") === "disable" || url.hash) {
    throw new Error("interview_production_database_invalid");
  }
  const emails = (env.INTERVIEW_PRODUCTION_CANARY_EMAILS ?? "")
    .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  const pages = (env.INTERVIEW_PRODUCTION_CANARY_PAGE_IDS ?? "")
    .split(",").map((value) => value.trim().toLowerCase().replaceAll("-", "")).filter(Boolean);
  if (!emails.length || !pages.length || emails.length > 5 || pages.length > 5 ||
      emails.some((email) => !/^[a-z0-9._%+-]+@campus2care\.org$/.test(email)) ||
      pages.some((page) => !/^[0-9a-f]{32}$/.test(page))) {
    throw new Error("interview_production_canary_allowlist_missing");
  }
  return { databaseUrl: raw, emails: new Set(emails), pages: new Set(pages) };
}

/** Explicit recipient AND precreated test page must match. Never allow real bulk applicants. */
export function assertProductionCanaryIdentity(
  campus: Campus, email: string, pageId: string, settings?: Settings,
) {
  if (campus !== "BU" && campus !== "BC") throw new Error("interview_invalid_campus");
  const config = productionCanaryConfig(settings);
  const normalizedEmail = email.trim().toLowerCase();
  const normalizedPage = pageId.toLowerCase().replaceAll("-", "");
  if (!config.emails.has(normalizedEmail) || !config.pages.has(normalizedPage)) {
    throw new Error("interview_production_canary_identity_denied");
  }
  return { campus, email: normalizedEmail, pageId: normalizedPage };
}
