import postgres, { type Sql } from "postgres";
import { interviewDatabase } from "./interview-db";

/**
 * Interviewer roster and weekly availability. Preview keeps using the
 * isolated staging database; production needs its own explicit switch and a
 * connection pinned to the expected Neon host. Applicant booking and sending
 * have separate gates and are not enabled by this.
 */
export function productionStaffEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.VERCEL_ENV === "production" && env.INTERVIEW_DATA_ENV === "production" &&
    env.INTERVIEW_PRODUCTION_STAFF_ENABLED === "true";
}

export function interviewStaffEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.VERCEL_ENV === "preview" || productionStaffEnabled(env);
}

let productionClient: Sql | undefined;
export function interviewStaffDatabase(): Sql {
  if (process.env.VERCEL_ENV !== "production") return interviewDatabase();
  if (!productionStaffEnabled()) throw new Error("interview_staff_disabled");
  const raw = process.env.INTERVIEW_DATABASE_URL ?? "";
  const expected = process.env.INTERVIEW_DATABASE_HOST ?? "";
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error("interview_staff_database_invalid"); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || parsed.hostname !== expected ||
      !expected.endsWith(".neon.tech") || !parsed.username || !parsed.password ||
      parsed.pathname.length < 2 || parsed.searchParams.get("sslmode") === "disable") {
    throw new Error("interview_staff_database_invalid");
  }
  productionClient ??= postgres(raw, {
    max: 2, connect_timeout: 8, idle_timeout: 15, ssl: "require", prepare: false,
    onnotice: () => undefined, connection: { application_name: "campus2care-interview-staff" },
  });
  return productionClient;
}

export type RosterMember = {
  id: string; email: string; name: string; campuses: ("BU" | "BC")[];
  teamRole: "lead" | "shadow"; leadId: string | null;
};

/** Current roster membership; removal or lost access takes effect immediately. */
export async function rosterMember(email: string, db: Sql = interviewStaffDatabase()): Promise<RosterMember | null> {
  const normalized = email.trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@campus2care\.org$/.test(normalized)) return null;
  const rows = await db<{ id: string; workspace_email: string; display_name: string;
    allowed_campuses: ("BU" | "BC")[]; team_role: "lead" | "shadow"; lead_interviewer_id: string | null }[]>`
    SELECT id, workspace_email, display_name, allowed_campuses, team_role, lead_interviewer_id
    FROM interview.interviewer
    WHERE lower(workspace_email) = ${normalized} AND staff_access AND removed_at IS NULL
    LIMIT 1`;
  const row = rows[0];
  return row ? { id: row.id, email: row.workspace_email.toLowerCase(), name: row.display_name,
    campuses: row.allowed_campuses, teamRole: row.team_role, leadId: row.lead_interviewer_id } : null;
}
