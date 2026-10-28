import { interviewDatabase } from "./interview-db";

/**
 * Durable transactional outbox foundation. No provider is connected here and
 * nothing schedules this function yet. A reviewed adapter must explicitly
 * implement idempotent Google/Notion/Gmail operations before activation.
 */
export type InterviewOutboxJob = {
  id: string;
  operation_key: string;
  provider: "google_calendar" | "gmail" | "notion";
  action: string;
  object_id: string;
  attempts: number;
};

export type OutboxResult =
  | { state: "done"; externalId: string | null }
  | { state: "retry"; errorCode: string }
  | { state: "reconcile_required"; errorCode: string }
  | { state: "failed"; errorCode: string };

export function isInterviewWorkerEnabled(): boolean {
  return process.env.VERCEL_ENV === "preview" &&
    process.env.INTERVIEW_OUTBOX_WORKER_ENABLED === "true";
}

export function outboxBackoffSeconds(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("invalid_outbox_attempt");
  const capped = Math.min(10, attempt);
  return Math.min(86400, 30 * (2 ** (capped - 1)));
}

function safeCode(code: string): string {
  // Durable errors must not contain email, names, OAuth tokens, or provider
  // payloads, so only a short machine-readable error slug is persisted.
  return /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "provider_error";
}

async function claimOne(): Promise<InterviewOutboxJob | null> {
  const sql = interviewDatabase();
  const rows = await sql<InterviewOutboxJob[]>`
    WITH candidate AS (
      SELECT id FROM interview.integration_outbox
      WHERE (
        (state IN ('queued','retry') AND next_attempt_at <= now())
        OR (state = 'processing' AND lease_until < now())
      )
      ORDER BY next_attempt_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE interview.integration_outbox AS j
    SET state = 'processing',
      attempts = j.attempts + 1,
      lease_until = now() + interval '90 seconds',
      updated_at = now()
    FROM candidate
    WHERE j.id = candidate.id
    RETURNING j.id, j.operation_key, j.provider, j.action,
      j.object_id, j.attempts
  `;
  return rows[0] ?? null;
}

async function finishJob(job: InterviewOutboxJob, result: OutboxResult) {
  const sql = interviewDatabase();
  const state = result.state === "retry" && job.attempts >= 6
    ? "failed" : result.state;
  const code = result.state === "done" ? null : safeCode(result.errorCode);
  const retrySeconds = outboxBackoffSeconds(job.attempts);
  const externalId = result.state === "done" ? result.externalId : null;

  const rows = await sql<{ id: string }[]>`
    UPDATE interview.integration_outbox
    SET state = ${state}, last_error_code = ${code},
      external_id = COALESCE(${externalId}, external_id),
      lease_until = NULL,
      next_attempt_at = CASE WHEN ${state} = 'retry'
        THEN now() + (${retrySeconds} * interval '1 second')
        ELSE next_attempt_at END,
      updated_at = now()
    WHERE id = ${job.id} AND state = 'processing'
      AND attempts = ${job.attempts}
    RETURNING id
  `;
  if (!rows.length) throw new Error("interview_outbox_lease_lost");
}

export type OutboxHandler = (job: InterviewOutboxJob) => Promise<OutboxResult>;

/**
 * Call only after a provider-specific handler is approved. Any unknown
 * outcome is held for reconciliation, never blindly resent.
 */
export async function processInterviewOutboxBatch(
  handler: OutboxHandler, maxJobs = 5,
): Promise<{ claimed: number; completed: number; needsReconciliation: number }> {
  if (!isInterviewWorkerEnabled()) throw new Error("interview_outbox_disabled");
  if (typeof handler !== "function" ||
      !Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 10) {
    throw new Error("invalid_interview_outbox_worker");
  }

  let claimed = 0;
  let completed = 0;
  let needsReconciliation = 0;
  for (let i = 0; i < maxJobs; i += 1) {
    const job = await claimOne();
    if (!job) break;
    claimed += 1;
    let result: OutboxResult;
    try {
      result = await handler(job);
      if (!result || !["done","retry","reconcile_required","failed"].includes(result.state)) {
        result = { state: "reconcile_required", errorCode: "invalid_provider_response" };
      }
    } catch {
      // Timeouts / process errors can happen AFTER a provider accepted a
      // request. Mark ambiguous until checked, preventing duplicate sends.
      result = { state: "reconcile_required", errorCode: "unknown_provider_outcome" };
    }
    if (result.state === "reconcile_required") needsReconciliation += 1;
    if (result.state === "done") completed += 1;
    await finishJob(job, result);
  }
  return { claimed, completed, needsReconciliation };
}

export async function interviewOutboxReadiness(): Promise<{
  pending: number; processing: number; retry: number;
  reconciliation: number; failed: number;
}> {
  const sql = interviewDatabase();
  const rows = await sql<{ state: string; total: number }[]>`
    SELECT state, count(*)::int AS total
    FROM interview.integration_outbox GROUP BY state
  `;
  const counts = new Map(rows.map((row) => [row.state, row.total]));
  return {
    pending: counts.get("queued") ?? 0,
    processing: counts.get("processing") ?? 0,
    retry: counts.get("retry") ?? 0,
    reconciliation: counts.get("reconcile_required") ?? 0,
    failed: counts.get("failed") ?? 0,
  };
}
