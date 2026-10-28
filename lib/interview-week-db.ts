import { interviewDatabase } from "./interview-db";
import { getWeek as getLegacyWeek } from "./interview-store";
import { buildInterviewSlots, type WeeklyConfirmation, validateWeeklyConfirmation } from "./interview-availability";

type StoredWeek = {
  status: WeeklyConfirmation["status"];
  confirmed_at: Date | null;
  effective_windows: WeeklyConfirmation["recurringWindows"];
  date_overrides: WeeklyConfirmation["overrides"];
  revision: string;
};

export type InterviewWeekSnapshot = {
  value: WeeklyConfirmation | null;
  revision: string | null;
  source: "postgres" | "legacy_blob" | "missing";
};

export class InterviewWeekConflict extends Error {
  constructor() { super("interview_week_modified_elsewhere"); }
}

/** Only the isolated preview switches its weekly confirmation authority to SQL. */
export function isPostgresInterviewWeeksEnabled(): boolean {
  return process.env.VERCEL_ENV === "preview" &&
    process.env.INTERVIEW_WEEK_STORAGE === "postgres";
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@campus2care\.org$/.test(normalized)) {
    throw new Error("invalid_interviewer_email");
  }
  return normalized;
}

function parseRevision(raw: string | null): { source: "postgres" | "legacy_blob" | "missing"; value: string | null } {
  if (raw === null) return { source: "missing", value: null };
  if (/^db:[1-9]\d*$/.test(raw)) return { source: "postgres", value: raw.slice(3) };
  if (raw.startsWith("blob:") && raw.length > 5 && raw.length < 250) {
    return { source: "legacy_blob", value: raw.slice(5) };
  }
  throw new InterviewWeekConflict();
}

export async function getAuthoritativeInterviewWeek(
  email: string, weekStart: string,
): Promise<InterviewWeekSnapshot> {
  const normalized = normalizeEmail(email);
  const sql = interviewDatabase();
  const result = await sql<StoredWeek[]>`
    SELECT w.status, w.confirmed_at, w.effective_windows, w.date_overrides,
      w.revision::text AS revision
    FROM interview.interviewer_week w
    JOIN interview.interviewer i ON i.id = w.interviewer_id
    WHERE lower(i.workspace_email) = ${normalized} AND w.week_start = ${weekStart}::date
    LIMIT 1
  `;
  const stored = result[0];
  if (stored) {
    const record: WeeklyConfirmation = {
      eaId: normalized, weekStart, status: stored.status,
      confirmedAt: stored.confirmed_at?.toISOString() ?? null,
      recurringWindows: stored.effective_windows, overrides: stored.date_overrides,
    };
    validateWeeklyConfirmation(record);
    return { value: record, revision: "db:" + stored.revision, source: "postgres" };
  }

  // Historical preview confirmations are displayed, not automatically made
  // bookable in Neon. The EA must reconfirm to migrate them into SQL.
  const legacy = await getLegacyWeek(normalized, weekStart);
  if (legacy.value) {
    validateWeeklyConfirmation(legacy.value);
    return {
      value: legacy.value,
      revision: legacy.revision ? "blob:" + legacy.revision : null,
      source: "legacy_blob",
    };
  }
  return { value: null, revision: null, source: "missing" };
}

export async function saveAuthoritativeInterviewWeek(
  email: string, weekStart: string, record: WeeklyConfirmation,
  expectedRevision: string | null,
): Promise<{ revision: string; conflictedBookings: number }> {
  const normalized = normalizeEmail(email);
  if (record.eaId !== normalized || record.weekStart !== weekStart ||
      !["confirmed", "unavailable"].includes(record.status)) {
    throw new Error("invalid_week_confirmation");
  }
  validateWeeklyConfirmation(record);
  const expected = parseRevision(expectedRevision);
  // A previous Blob-only record must be reviewed and explicitly reconfirmed;
  // a stale Blob etag is never allowed to migrate over an unseen edit.
  if (expected.source !== "postgres") {
    const legacy = await getLegacyWeek(normalized, weekStart);
    if (expected.source === "legacy_blob" &&
        (!legacy.value || legacy.revision !== expected.value)) {
      throw new InterviewWeekConflict();
    }
    if (expected.source === "missing" && legacy.value) {
      throw new InterviewWeekConflict();
    }
  }

  const sql = interviewDatabase();
  return sql.begin(async (tx) => {
    // Signing into Workspace doesn't automatically activate someone to host
    // interviews. New roster entries default to INACTIVE and ZERO capacity.
    await tx`
      INSERT INTO interview.interviewer
        (workspace_email, display_name, active, allowed_campuses, weekly_capacity_limit)
      VALUES (${normalized}, ${normalized.split("@")[0]}, false, ARRAY['BU']::text[], 0)
      ON CONFLICT DO NOTHING
    `;
    const interviewers = await tx<{ id: string }[]>`
      SELECT id FROM interview.interviewer
      WHERE lower(workspace_email) = ${normalized} FOR UPDATE
    `;
    const interviewer = interviewers[0];
    if (!interviewer) throw new Error("interviewer_roster_unavailable");

    // The same week row is locked when booking. That serializes edits and
    // reservations so no booking silently bypasses confirmed availability.
    const stored = await tx<{ revision: string }[]>`
      SELECT revision::text AS revision FROM interview.interviewer_week
      WHERE interviewer_id = ${interviewer.id} AND week_start = ${weekStart}::date
      FOR UPDATE
    `;
    let nextRevision: string;
    if (!stored.length) {
      if (expected.source === "postgres") throw new InterviewWeekConflict();
      const inserted = await tx<{ revision: string }[]>`
        INSERT INTO interview.interviewer_week
          (interviewer_id, week_start, status, confirmed_at,
           effective_windows, date_overrides)
        VALUES (${interviewer.id}, ${weekStart}::date, ${record.status},
          ${record.confirmedAt}, ${tx.json(record.recurringWindows)}::jsonb,
          ${tx.json(record.overrides)}::jsonb)
        ON CONFLICT DO NOTHING
        RETURNING revision::text AS revision
      `;
      if (!inserted.length) throw new InterviewWeekConflict();
      nextRevision = inserted[0].revision;
    } else {
      if (expected.source !== "postgres" || stored[0].revision !== expected.value) {
        throw new InterviewWeekConflict();
      }
      const changed = await tx<{ revision: string }[]>`
        UPDATE interview.interviewer_week
        SET status = ${record.status}, confirmed_at = ${record.confirmedAt},
          effective_windows = ${tx.json(record.recurringWindows)}::jsonb,
          date_overrides = ${tx.json(record.overrides)}::jsonb,
          revision = revision + 1, updated_at = now()
        WHERE interviewer_id = ${interviewer.id} AND week_start = ${weekStart}::date
        RETURNING revision::text AS revision
      `;
      nextRevision = changed[0].revision;
    }

    const active = await tx<{ id:string; starts_at: Date; blocks_until: Date }[]>`
      SELECT id, starts_at, blocks_until FROM interview.reservation
      WHERE interviewer_id = ${interviewer.id}
        AND (starts_at AT TIME ZONE 'America/New_York')::date BETWEEN
          ${weekStart}::date AND (${weekStart}::date + 6)
        AND status IN ('held','calendar_pending','confirmed',
          'reschedule_pending','cancel_pending','reconcile_required')
    `;
    // Booked appointments are never canceled by an availability edit. Flag
    // appointments outside the new confirmed windows for leadership follow-up.
    const candidates = record.status === "confirmed" ? buildInterviewSlots(record) : [];
    const conflicts = active.filter((booking) => {
      const candidate = candidates.find((slot) => {
        const localStart = new Date(booking.starts_at);
        const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/New_York", year: "numeric", month: "2-digit",
          day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
        }).formatToParts(localStart);
        const part = (kind: string) => parts.find((p) => p.type === kind)?.value ?? "";
        const date = part("year") + "-" + part("month") + "-" + part("day");
        const minute = Number(part("hour")) * 60 + Number(part("minute"));
        return slot.date === date && slot.startMinute === minute;
      });
      return !candidate;
    });
    for(const booking of active) {
      await tx`UPDATE interview.reservation SET conflict_reason=${conflicts.some((conflict)=>conflict.id===booking.id)?"outside_confirmed_availability":null}
        WHERE id=${booking.id} AND (conflict_reason IS NULL OR conflict_reason='outside_confirmed_availability')`;
    }
    return { revision: "db:" + nextRevision, conflictedBookings: conflicts.length };
  });
}

/** Read-only roster state. Never make staff active during a weekly check-in. */
export async function readInterviewRosterReadiness(): Promise<
  Map<string, { active: boolean; weeklyCapacityLimit: number; allowedCampuses: string[] }>
> {
  const sql = interviewDatabase();
  const rows = await sql<{
    email: string; active: boolean; weekly_capacity_limit: number;
    allowed_campuses: string[];
  }[]>`
    SELECT lower(workspace_email) AS email, active,
      weekly_capacity_limit, allowed_campuses
    FROM interview.interviewer ORDER BY workspace_email LIMIT 200
  `;
  return new Map(rows.map((row) => [row.email, {
    active: row.active,
    weeklyCapacityLimit: row.weekly_capacity_limit,
    allowedCampuses: row.allowed_campuses,
  }]));
}
