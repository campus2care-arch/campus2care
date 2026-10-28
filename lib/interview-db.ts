import postgres, { type Sql } from "postgres";

/**
 * Private transactional interview database. Never reuse the volunteer
 * application's storage or expose this connection in client-side code.
 */
let client: Sql | undefined;

export function interviewDatabase(): Sql {
  if (process.env.VERCEL_ENV === "production") {
    throw new Error("interview_database_production_disabled");
  }
  const raw = process.env.INTERVIEW_DATABASE_URL;
  if (!raw) throw new Error("interview_database_not_configured");
  const url = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname.endsWith(".neon.tech") || !url.username || !url.pathname) {
    throw new Error("interview_database_invalid_connection");
  }
  if (!client) {
    client = postgres(raw, {
      max: 3,
      idle_timeout: 20,
      connect_timeout: 8,
      ssl: "require",
      prepare: false,
      onnotice: () => undefined,
    });
  }
  return client;
}

export function requireInterviewStagingBooking(): void {
  if (process.env.VERCEL_ENV !== "preview" ||
      process.env.INTERVIEW_BOOKING_ENABLED !== "true") {
    throw new Error("interview_booking_disabled");
  }
}

export function postgresConflictCode(error: unknown): "slot_taken" | "already_booked" | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  if (code === "23P01") return "slot_taken";
  if (code === "23505") return "already_booked";
  return null;
}

/** Admin health response contains no credentials or applicant data. */
export async function interviewSchemaHealth(): Promise<{ connected: true; schemaVersion: number }> {
  const sql = interviewDatabase();
  const rows = await sql<{ present: boolean }[]> `
    SELECT to_regclass('interview.reservation') IS NOT NULL
      AND to_regclass('interview.invitation') IS NOT NULL
      AND to_regclass('interview.integration_outbox') IS NOT NULL AS present
  `;
  if (!rows[0]?.present) throw new Error("interview_database_schema_missing");
  return { connected: true, schemaVersion: 1 };
}
