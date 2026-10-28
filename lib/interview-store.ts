import { createHash } from "node:crypto";
import { get, head, put } from "@vercel/blob";
import {
  type WeeklyConfirmation, type WeeklyWindows, validateWeeklyConfirmation,
  mondayForDate,
} from "./interview-availability";

/** Small, isolated, conditionally updated EA-availability store.
 * The booking engine will use a separate transactional database; this is NOT
 * an acceptable store for concurrent student reservations.
 */
const PREFIX = "interviews/availability/v1";
const options = { access: "private" as const, addRandomSuffix: false, contentType: "application/json" };

export function staffStoreToken(): string {
  // Never reuse the submission-recovery Blob token or store.
  if (process.env.INTERVIEW_STAFF_ENABLED !== "true" ||
      !process.env.INTERVIEW_BLOB_READ_WRITE_TOKEN) {
    throw new Error("interview_staff_storage_unavailable");
  }
  return process.env.INTERVIEW_BLOB_READ_WRITE_TOKEN;
}

function pathFor(email: string, suffix: string) {
  const digest = createHash("sha256").update(email.toLowerCase().trim()).digest("hex");
  return PREFIX + "/" + digest + "/" + suffix + ".json";
}

export type RecurringTemplate = {
  eaId: string;
  recurringWindows: WeeklyWindows[];
  updatedAt: string;
};

type Versioned<T> = { value: T; revision: string | null };

async function read<T>(path: string): Promise<Versioned<T>> {
  const token = staffStoreToken();
  const response = await get(path, { access: "private", token, useCache: false });
  if (!response) return { value: null as T, revision: null };
  if (response.statusCode !== 200) throw new Error("interview_storage_read_failed");
  const metadata = await head(path, { token });
  const value = await new Response(response.stream).json() as T;
  return { value, revision: metadata.etag };
}

async function write<T>(path: string, value: T, revision: string | null): Promise<string> {
  const token = staffStoreToken();
  const result = await put(path, JSON.stringify(value), {
    ...options, token, allowOverwrite: revision !== null,
    ...(revision === null ? {} : { ifMatch: revision }),
  });
  return result.etag;
}

export async function getTemplate(email: string): Promise<Versioned<RecurringTemplate | null>> {
  return read<RecurringTemplate | null>(pathFor(email, "template"));
}

export async function getWeek(email: string, weekStart: string): Promise<Versioned<WeeklyConfirmation | null>> {
  if (mondayForDate(weekStart) !== weekStart) throw new Error("invalid_week_start");
  return read<WeeklyConfirmation | null>(pathFor(email, "week-" + weekStart));
}

export function validateTemplate(template: RecurringTemplate): void {
  validateWeeklyConfirmation({
    eaId: template.eaId,
    weekStart: "2026-11-02",
    status: "pending", confirmedAt: null,
    recurringWindows: template.recurringWindows,
    overrides: [],
  });
}

export async function saveTemplate(
  email: string,
  windows: WeeklyWindows[],
  expectedRevision: string | null,
): Promise<string> {
  const value: RecurringTemplate = {
    eaId: email, recurringWindows: windows, updatedAt: new Date().toISOString(),
  };
  validateTemplate(value);
  return write(pathFor(email, "template"), value, expectedRevision);
}

export async function saveWeek(
  email: string,
  weekStart: string,
  record: WeeklyConfirmation,
  expectedRevision: string | null,
): Promise<string> {
  if (record.eaId !== email || record.weekStart !== weekStart ||
      !["confirmed", "unavailable"].includes(record.status)) {
    throw new Error("invalid_week_confirmation");
  }
  validateWeeklyConfirmation(record);
  return write(pathFor(email, "week-" + weekStart), record, expectedRevision);
}

export function currentNYDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric",
    month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((x) => x.type === type)?.value;
  return part("year") + "-" + part("month") + "-" + part("day");
}

export function permittedWeek(weekStart: string, now = new Date()): boolean {
  const todayMonday = mondayForDate(currentNYDate(now));
  if (mondayForDate(weekStart) !== weekStart) return false;
  const start = new Date(todayMonday + "T00:00:00Z").getTime();
  const target = new Date(weekStart + "T00:00:00Z").getTime();
  return target >= start && target <= start + 28 * 86400000;
}
