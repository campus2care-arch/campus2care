import type { Sql } from "postgres";
import { productionRealConfig } from "./interview-production-launch";
import { productionInterviewDatabase } from "./interview-production-db";
import { readSlotTimetable } from "./interview-founder-slots";
import { liveTestFixture } from "./interview-production-verification-gate";
import { issueProductionCanaryInvitation } from "./interview-production-canary-invitation";
import { instantToEasternLocal } from "./interview-timezone";
import type { Campus } from "./interview-notion-contract";

/**
 * Live-release booking check for the founder dashboard. It reports real provider,
 * capacity and delivery state; it never books, sends or changes applicant data.
 */
export type LiveBookingStatus = {
  mode: "live";
  checkedAt: string;
  googleCredential: { connected: boolean; account: string | null; calendarScope: boolean; gmailScope: boolean; updatedAt: string | null };
  notionConfigured: boolean;
  openSlots: Record<Campus, number>;
  blockedSlots: Record<Campus, number>;
  bookedSlots: Record<Campus, number>;
  outbox: { pending: number; failed: number; reconcileRequired: number; lastDoneAt: string | null };
  testReservations: Array<{ campus: Campus; status: string; startsAt: string; hasMeet: boolean; hasCalendarEvent: boolean }>;
  problems: string[];
};

function mondayOf(date: Date): string {
  const local = instantToEasternLocal(date);
  const d = new Date(local.date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d.toISOString().slice(0, 10);
}

export async function liveBookingStatus(db: Sql = productionInterviewDatabase(), now = new Date()): Promise<LiveBookingStatus> {
  productionRealConfig();
  const problems: string[] = [];
  const credentials = await db<{ provider: string; account_email: string; granted_scopes: unknown; updated_at: Date }[]>`
    SELECT provider, account_email, granted_scopes, updated_at FROM interview.google_provider_credential
    WHERE provider IN ('calendar','gmail') ORDER BY updated_at DESC`;
  const calendarCredential = credentials.find(credential => credential.provider === "calendar");
  const gmailCredential = credentials.find(credential => credential.provider === "gmail");
  const scopesFor = (credential: typeof credentials[number] | undefined) =>
    Array.isArray(credential?.granted_scopes) ? (credential.granted_scopes as unknown[]).map(String) : [];
  const googleCredential = {
    connected: !!calendarCredential && !!gmailCredential,
    account: calendarCredential?.account_email ?? gmailCredential?.account_email ?? null,
    calendarScope: scopesFor(calendarCredential).some(scope => scope.includes("calendar")),
    gmailScope: scopesFor(gmailCredential).some(scope => scope.includes("gmail")),
    updatedAt: [calendarCredential?.updated_at, gmailCredential?.updated_at]
      .filter((value): value is Date => !!value)
      .sort((a, b) => b.getTime() - a.getTime())[0]?.toISOString() ?? null,
  };
  if (!calendarCredential) problems.push("google_calendar_not_connected");
  else if (!googleCredential.calendarScope) problems.push("google_calendar_scope_missing");
  if (!gmailCredential) problems.push("google_gmail_not_connected");
  else if (!googleCredential.gmailScope) problems.push("google_gmail_scope_missing");
  const notionConfigured = (process.env.INTERVIEW_NOTION_LIVE_TOKEN ?? "").length >= 20;
  if (!notionConfigured) problems.push("notion_not_configured");

  const openSlots: Record<Campus, number> = { BU: 0, BC: 0 };
  const blockedSlots: Record<Campus, number> = { BU: 0, BC: 0 };
  const bookedSlots: Record<Campus, number> = { BU: 0, BC: 0 };
  const thisWeek = mondayOf(now);
  const next = new Date(thisWeek + "T12:00:00Z"); next.setUTCDate(next.getUTCDate() + 7);
  for (const week of [thisWeek, next.toISOString().slice(0, 10)]) {
    for (const slot of await readSlotTimetable("ALL", week, db)) {
      if (Date.parse(slot.startsAt) <= now.getTime()) continue;
      if (slot.status === "open") openSlots[slot.campus]++;
      else if (slot.status === "booked") bookedSlots[slot.campus]++;
      else blockedSlots[slot.campus]++;
    }
  }
  if (openSlots.BU === 0) problems.push("no_open_bu_slots");
  if (openSlots.BC === 0) problems.push("no_open_bc_slots");

  const box = await db<{ pending: number; failed: number; recon: number; last_done: Date | null }[]>`
    SELECT count(*) FILTER (WHERE state IN ('queued','processing','retry'))::int AS pending,
      count(*) FILTER (WHERE state = 'failed')::int AS failed,
      count(*) FILTER (WHERE state = 'reconcile_required')::int AS recon,
      max(updated_at) FILTER (WHERE state = 'done') AS last_done
    FROM interview.integration_outbox`;
  const outbox = { pending: box[0]?.pending ?? 0, failed: box[0]?.failed ?? 0,
    reconcileRequired: box[0]?.recon ?? 0, lastDoneAt: box[0]?.last_done?.toISOString() ?? null };
  if (outbox.failed) problems.push("integration_failures");
  if (outbox.reconcileRequired) problems.push("integration_reconciliation_required");

  const pages = [liveTestFixture("BU").pageId, liveTestFixture("BC").pageId];
  const test = await db<{ campus: Campus; status: string; starts_at: Date; meet_url: string | null; calendar_event_id: string | null }[]>`
    SELECT campus, status, starts_at, meet_url, calendar_event_id FROM interview.reservation
    WHERE notion_page_id = ANY(${pages}::text[]) ORDER BY created_at DESC LIMIT 6`;
  return { mode: "live", checkedAt: now.toISOString(), googleCredential, notionConfigured,
    openSlots, blockedSlots, bookedSlots, outbox,
    testReservations: test.map(r => ({ campus: r.campus, status: r.status, startsAt: r.starts_at.toISOString(),
      hasMeet: !!r.meet_url, hasCalendarEvent: !!r.calendar_event_id })),
    problems };
}

/** Founder-only: a booking link for the fixed BU or BC system-test record. Sends nothing. */
export async function issueLiveTestBookingLink(campus: Campus, origin: string) {
  const fixture = liveTestFixture(campus);
  const issued = await issueProductionCanaryInvitation(fixture);
  return { campus, testEmail: fixture.email, expiresAt: issued.expiresAt,
    bookingLink: origin + "/interview#token=" + encodeURIComponent(issued.invitationToken) };
}
