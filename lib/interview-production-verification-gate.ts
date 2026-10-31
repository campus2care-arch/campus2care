import postgres, { type Sql } from "postgres";
import type { Campus } from "./interview-notion-contract";

type Environment = Record<string, string | undefined>;
const FIXTURES = {
  BU: {
    email: "contact+interview-canary-bu@campus2care.org",
    pageId: "408d6c55a9de81da9063fe9a32d88d9b",
  },
  BC: {
    email: "contact+interview-canary-bc@campus2care.org",
    pageId: "408d6c55a9de8164b8faf8d438c8fa71",
  },
} as const;

function current(): Environment {
  return {
    VERCEL_ENV: process.env["VERCEL_ENV"],
    INTERVIEW_DATA_ENV: process.env["INTERVIEW_DATA_ENV"],
    INTERVIEW_PROVIDER_AUTH_ENABLED: process.env["INTERVIEW_PROVIDER_AUTH_ENABLED"],
    INTERVIEW_PRODUCTION_VERIFICATION_CANARY_ENABLED: process.env["INTERVIEW_PRODUCTION_VERIFICATION_CANARY_ENABLED"],
    INTERVIEW_PRODUCTION_VERIFICATION_SENDS_APPROVED: process.env["INTERVIEW_PRODUCTION_VERIFICATION_SENDS_APPROVED"],
    INTERVIEW_PRODUCTION_ENABLED: process.env["INTERVIEW_PRODUCTION_ENABLED"],
    INTERVIEW_BOOKING_ENABLED: process.env["INTERVIEW_BOOKING_ENABLED"],
    INTERVIEW_OUTREACH_ENABLED: process.env["INTERVIEW_OUTREACH_ENABLED"],
    INTERVIEW_PRODUCTION_ENROLLMENT_ENABLED: process.env["INTERVIEW_PRODUCTION_ENROLLMENT_ENABLED"],
    INTERVIEW_CALENDAR_WRITES_ENABLED: process.env["INTERVIEW_CALENDAR_WRITES_ENABLED"],
    INTERVIEW_GMAIL_SENDS_ENABLED: process.env["INTERVIEW_GMAIL_SENDS_ENABLED"],
    INTERVIEW_NOTION_WRITES_ENABLED: process.env["INTERVIEW_NOTION_WRITES_ENABLED"],
    INTERVIEW_OUTBOX_WORKER_ENABLED: process.env["INTERVIEW_OUTBOX_WORKER_ENABLED"],
    INTERVIEW_DATABASE_URL: process.env["INTERVIEW_DATABASE_URL"],
    INTERVIEW_DATABASE_HOST: process.env["INTERVIEW_DATABASE_HOST"],
    INTERVIEW_PRODUCTION_CANARY_EMAILS: process.env["INTERVIEW_PRODUCTION_CANARY_EMAILS"],
    INTERVIEW_PRODUCTION_CANARY_PAGE_IDS: process.env["INTERVIEW_PRODUCTION_CANARY_PAGE_IDS"],
  };
}

/**
 * A deliberately separate production gate for two test-only email verifications.
 * It REQUIRES that all ordinary booking, outreach and provider-write flags are OFF.
 * It never authorizes Google Calendar, production Notion writes, or interview holds.
 */
export function productionVerificationCanaryConfig(env: Environment = current()) {
  if (env.VERCEL_ENV !== "production" ||
      env.INTERVIEW_DATA_ENV !== "production" ||
      env.INTERVIEW_PROVIDER_AUTH_ENABLED !== "true" ||
      env.INTERVIEW_PRODUCTION_VERIFICATION_CANARY_ENABLED !== "true") {
    throw new Error("production_verification_canary_disabled");
  }
  for (const key of [
    "INTERVIEW_PRODUCTION_ENABLED", "INTERVIEW_BOOKING_ENABLED",
    "INTERVIEW_OUTREACH_ENABLED", "INTERVIEW_PRODUCTION_ENROLLMENT_ENABLED",
    "INTERVIEW_CALENDAR_WRITES_ENABLED", "INTERVIEW_GMAIL_SENDS_ENABLED",
    "INTERVIEW_NOTION_WRITES_ENABLED", "INTERVIEW_OUTBOX_WORKER_ENABLED",
  ]) {
    if (env[key] !== "false") throw new Error("production_verification_broad_writes_must_be_disabled");
  }
  let parsed: URL;
  try { parsed = new URL(env.INTERVIEW_DATABASE_URL ?? ""); }
  catch { throw new Error("production_verification_database_invalid"); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !parsed.hostname.endsWith(".neon.tech") ||
      parsed.hostname !== env.INTERVIEW_DATABASE_HOST ||
      !parsed.username || !parsed.password || parsed.pathname.length <= 1 ||
      parsed.hash || parsed.searchParams.get("sslmode") === "disable") {
    throw new Error("production_verification_database_invalid");
  }
  const emails = (env.INTERVIEW_PRODUCTION_CANARY_EMAILS ?? "").split(",")
    .map(value => value.trim().toLowerCase()).filter(Boolean).sort();
  const pages = (env.INTERVIEW_PRODUCTION_CANARY_PAGE_IDS ?? "").split(",")
    .map(value => value.trim().toLowerCase().replaceAll("-", "")).filter(Boolean).sort();
  const requiredEmails = [FIXTURES.BU.email,FIXTURES.BC.email].sort();
  const requiredPages = [FIXTURES.BU.pageId,FIXTURES.BC.pageId].sort();
  if (emails.length !== 2 || pages.length !== 2 ||
      emails.some((value,index) => value !== requiredEmails[index]) ||
      pages.some((value,index) => value !== requiredPages[index])) {
    throw new Error("production_verification_allowlist_invalid");
  }
  return { databaseUrl: parsed.toString(),
    emailSendsApproved: env.INTERVIEW_PRODUCTION_VERIFICATION_SENDS_APPROVED === "true" };
}

export function assertProductionVerificationIdentity(
  campus: Campus, email: string, pageId: string,
) {
  productionVerificationCanaryConfig();
  const fixture = FIXTURES[campus];
  if (!fixture || email.trim().toLowerCase() !== fixture.email ||
      pageId.toLowerCase().replaceAll("-", "") !== fixture.pageId) {
    throw new Error("production_verification_identity_denied");
  }
  return { campus, email: fixture.email, pageId: fixture.pageId };
}

export function assertProductionVerificationRecipient(campus: Campus, email: string) {
  productionVerificationCanaryConfig();
  const fixture = FIXTURES[campus];
  if (!fixture || email.trim().toLowerCase() !== fixture.email) {
    throw new Error("production_verification_recipient_denied");
  }
  return fixture.email;
}

let client: Sql | undefined;
export function productionVerificationCanaryDatabase(): Sql {
  const config = productionVerificationCanaryConfig();
  client ??= postgres(config.databaseUrl, {
    max: 2, connect_timeout: 8, idle_timeout: 15, ssl: "require",
    prepare: false, onnotice: () => undefined,
    connection: { application_name: "campus2care-test-email-verification" },
  });
  return client;
}
