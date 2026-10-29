import postgres from "postgres";

/**
 * A production-only READ-ONLY preflight. This connection is deliberately
 * independent of the synthetic interviewDatabase() and cannot create
 * bookings, invitations, Calendar events, Notion edits, or email.
 */
type PreflightEnvironment = Record<string, string | undefined>;
export function validatedProductionPreflightConnection(env?: PreflightEnvironment): string {
  const values = env ?? {
    VERCEL_ENV: process.env["VERCEL_ENV"],
    INTERVIEW_DATA_ENV: process.env["INTERVIEW_DATA_ENV"],
    INTERVIEW_PRODUCTION_PREFLIGHT_ENABLED: process.env["INTERVIEW_PRODUCTION_PREFLIGHT_ENABLED"],
    INTERVIEW_PRODUCTION_ENABLED: process.env["INTERVIEW_PRODUCTION_ENABLED"],
    INTERVIEW_BOOKING_ENABLED: process.env["INTERVIEW_BOOKING_ENABLED"],
    INTERVIEW_OUTREACH_ENABLED: process.env["INTERVIEW_OUTREACH_ENABLED"],
    INTERVIEW_CALENDAR_WRITES_ENABLED: process.env["INTERVIEW_CALENDAR_WRITES_ENABLED"],
    INTERVIEW_GMAIL_SENDS_ENABLED: process.env["INTERVIEW_GMAIL_SENDS_ENABLED"],
    INTERVIEW_OUTBOX_WORKER_ENABLED: process.env["INTERVIEW_OUTBOX_WORKER_ENABLED"],
    INTERVIEW_PRODUCTION_ENROLLMENT_ENABLED: process.env["INTERVIEW_PRODUCTION_ENROLLMENT_ENABLED"],
    INTERVIEW_NOTION_WRITES_ENABLED: process.env["INTERVIEW_NOTION_WRITES_ENABLED"],
    INTERVIEW_DATABASE_HOST: process.env["INTERVIEW_DATABASE_HOST"],
    INTERVIEW_DATABASE_URL: process.env["INTERVIEW_DATABASE_URL"],
  };
  if (values.VERCEL_ENV !== "production" ||
      values.INTERVIEW_DATA_ENV !== "production" ||
      values.INTERVIEW_PRODUCTION_PREFLIGHT_ENABLED !== "true" ||
      values.INTERVIEW_PRODUCTION_ENABLED !== "false") {
    throw new Error("interview_production_preflight_disabled");
  }
  const mustRemainOff = [
    "INTERVIEW_BOOKING_ENABLED",
    "INTERVIEW_OUTREACH_ENABLED",
    "INTERVIEW_CALENDAR_WRITES_ENABLED",
    "INTERVIEW_GMAIL_SENDS_ENABLED",
    "INTERVIEW_OUTBOX_WORKER_ENABLED",
    "INTERVIEW_PRODUCTION_ENROLLMENT_ENABLED",
    "INTERVIEW_NOTION_WRITES_ENABLED",
  ];
  if (mustRemainOff.some(name => values[name] !== "false")) {
    throw new Error("interview_production_preflight_unsafe");
  }
  const raw = values.INTERVIEW_DATABASE_URL;
  const expectedHost = values.INTERVIEW_DATABASE_HOST;
  if (!raw || !expectedHost) throw new Error("interview_production_preflight_unconfigured");
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { throw new Error("interview_production_preflight_invalid_database"); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !parsed.hostname.endsWith(".neon.tech") ||
      parsed.hostname !== expectedHost ||
      !parsed.username || !parsed.password || parsed.pathname.length <= 1 ||
      parsed.hash || parsed.searchParams.has("sslmode") && parsed.searchParams.get("sslmode") === "disable") {
    throw new Error("interview_production_preflight_invalid_database");
  }
  return raw;
}

export async function readProductionInterviewPreflight() {
  const raw = validatedProductionPreflightConnection();
  const sql = postgres(raw, {
    max: 1, connect_timeout: 5, idle_timeout: 5, ssl: "require",
    prepare: false,
    connection: { default_transaction_read_only: "on", application_name: "campus2care-interview-preflight" },
  });
  try {
    const rows = await sql<{
      schema_ok: boolean; week_slots: number; pending_bookings: number;
      invitation_count: number; pending_jobs: number;
    }[]>`SELECT
      (to_regclass('interview.schedule_slot') IS NOT NULL
        AND to_regclass('interview.reservation') IS NOT NULL
        AND to_regclass('interview.invitation') IS NOT NULL
        AND to_regclass('interview.integration_outbox') IS NOT NULL) AS schema_ok,
      (SELECT count(*)::int FROM interview.schedule_slot WHERE
        (starts_at AT TIME ZONE 'America/New_York')::date BETWEEN date '2026-11-02' AND date '2026-11-08') AS week_slots,
      (SELECT count(*)::int FROM interview.reservation WHERE status NOT IN ('canceled','expired','failed')) AS pending_bookings,
      (SELECT count(*)::int FROM interview.invitation WHERE revoked_at IS NULL) AS invitation_count,
      (SELECT count(*)::int FROM interview.integration_outbox WHERE state <> 'done') AS pending_jobs`;
    if (!rows[0]?.schema_ok) throw new Error("interview_production_preflight_schema_missing");
    return {
      checkedAt: new Date().toISOString(), ...rows[0],
      bookingEnabled: false, outreachEnabled: false, readOnly: true,
    };
  } finally {
    await sql.end({ timeout: 3 });
  }
}
