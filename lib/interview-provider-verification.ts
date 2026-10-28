import { interviewDatabase } from "./interview-db";
import { googleProviderAccessToken, providerDetails, type GoogleProvider } from "./interview-google-provider-auth";
import { cleanUpSyntheticCalendarEvent, verifySyntheticCalendarLifecycle, type CalendarVerification } from "./interview-calendar-verification";

type TestRow = { id: string; operation_key: string; state: string; attempts: number; payload_ref: Record<string, unknown>; last_error_code: string | null };
export type ProviderTestStatus = { runId: string; state: string; idempotent: boolean; meetReady: boolean; canceled: boolean; errorCode: string | null };
function preview() { if (process.env.VERCEL_ENV !== "preview") throw new Error("provider_verification_preview_only"); }
function safeCode(error: unknown): string {
  return error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/.test(error.message) ? error.message : "provider_verification_failed";
}
function status(row: TestRow): ProviderTestStatus {
  return { runId: row.id, state: row.state, idempotent: row.payload_ref.idempotent === true,
    meetReady: row.payload_ref.meetReady === true, canceled: row.payload_ref.canceled === true, errorCode: row.last_error_code };
}
async function checkConnection(provider: GoogleProvider, transport: typeof fetch) {
  const details = providerDetails(provider);
  try {
    const token = await googleProviderAccessToken(provider, transport);
    const identity = await transport("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: "Bearer " + token }, cache: "no-store", signal: AbortSignal.timeout(8000),
    });
    if (!identity.ok) throw new Error("provider_identity_check_failed");
    const account = await identity.json() as { email?: string; email_verified?: boolean };
    if (account.email !== details.email || account.email_verified !== true) throw new Error("provider_account_mismatch");
    if (provider === "calendar") {
      const response = await transport("https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=1&fields=kind", {
        headers: { Authorization: "Bearer " + token }, cache: "no-store", signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error("calendar_api_check_failed");
    }
    return { provider, account: details.email, verified: true, errorCode: null,
      check: provider === "calendar" ? "Refresh, account identity and Calendar API verified" : "Refresh and account identity verified; sending not exercised" };
  } catch (error) {
    return { provider, account: details.email, verified: false, errorCode: safeCode(error), check: "Connection needs attention" };
  }
}
export async function providerVerificationStatus(transport: typeof fetch = fetch) {
  preview();
  const connections = await Promise.all([checkConnection("calendar", transport), checkConnection("gmail", transport)]);
  const rows = await interviewDatabase()<TestRow[]>`
    SELECT id, operation_key, state, attempts, payload_ref, last_error_code
    FROM interview.integration_outbox WHERE action='synthetic_calendar_verification'
    ORDER BY created_at DESC LIMIT 1
  `;
  return { connections, lastTest: rows[0] ? status(rows[0]) : null };
}
export async function runSyntheticCalendarVerification(runId: string, cleanupOnly = false, transport: typeof fetch = fetch): Promise<ProviderTestStatus> {
  preview();
  if (process.env.INTERVIEW_SYNTHETIC_CALENDAR_ENABLED !== "true") throw new Error("synthetic_calendar_check_disabled");
  if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(runId)) throw new Error("invalid_synthetic_run");
  const sql = interviewDatabase();
  const accessToken = await googleProviderAccessToken("calendar", transport);
  const startsAt = new Date(Math.ceil((Date.now() + 86400000) / 1800000) * 1800000).toISOString();
  const endsAt = new Date(Date.parse(startsAt) + 1200000).toISOString();
  let claimed: TestRow[] = [];
  if (!cleanupOnly) {
    claimed = await sql<TestRow[]>`
      INSERT INTO interview.integration_outbox (id,operation_key,provider,action,object_id,payload_ref,state,attempts,lease_until)
      VALUES (${runId},${"synthetic_calendar:" + runId},'google_calendar','synthetic_calendar_verification',${runId},
        ${sql.json({ synthetic: true, startsAt, endsAt })},'processing',1,now()+interval '90 seconds')
      ON CONFLICT (id) DO NOTHING
      RETURNING id, operation_key, state, attempts, payload_ref, last_error_code
    `;
  }
  const isNew = claimed.length > 0;
  if (!isNew) {
    // Existing or uncertain runs can only be cleaned up, never create again.
    claimed = await sql<TestRow[]>`
      UPDATE interview.integration_outbox SET state='processing',attempts=attempts+1,lease_until=now()+interval '90 seconds',updated_at=now()
      WHERE id=${runId} AND action='synthetic_calendar_verification'
        AND (state='reconcile_required' OR (state='processing' AND lease_until<now()))
      RETURNING id, operation_key, state, attempts, payload_ref, last_error_code
    `;
  }
  if (!claimed.length) {
    const rows = await sql<TestRow[]>`SELECT id,operation_key,state,attempts,payload_ref,last_error_code FROM interview.integration_outbox WHERE id=${runId} AND action='synthetic_calendar_verification'`;
    if (!rows[0]) throw new Error("synthetic_run_not_found");
    return status(rows[0]);
  }
  const job = claimed[0];
  let result: CalendarVerification;
  if (isNew) {
    result = await verifySyntheticCalendarLifecycle({ accessToken, operationKey: job.operation_key, startsAt, endsAt }, transport, async (progress) => {
      await sql`UPDATE interview.integration_outbox SET payload_ref=${sql.json({ ...job.payload_ref, ...progress })},updated_at=now()
        WHERE id=${job.id} AND state='processing' AND attempts=${job.attempts}`;
    });
  } else {
    let canceled = false;
    try { canceled = await cleanUpSyntheticCalendarEvent(accessToken, job.operation_key, transport); } catch { /* Remain visible for reconciliation. */ }
    result = { idempotent: job.payload_ref.idempotent === true, meetReady: job.payload_ref.meetReady === true, canceled,
      errorCode: canceled ? (job.payload_ref.meetReady === true ? null : "synthetic_check_incomplete") : "synthetic_calendar_cleanup_required" };
  }
  const state = !result.canceled ? "reconcile_required" : result.idempotent && result.meetReady && !result.errorCode ? "done" : "failed";
  const finished = await sql<TestRow[]>`
    UPDATE interview.integration_outbox SET state=${state},lease_until=NULL,payload_ref=${sql.json({ ...job.payload_ref, ...result })},
      last_error_code=${result.errorCode},updated_at=now()
    WHERE id=${job.id} AND state='processing' AND attempts=${job.attempts}
    RETURNING id, operation_key, state, attempts, payload_ref, last_error_code
  `;
  if (!finished[0]) throw new Error("synthetic_verification_lease_lost");
  return status(finished[0]);
}
