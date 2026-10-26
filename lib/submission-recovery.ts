import { createHash } from "node:crypto";
import { get, head, put, del, list } from "@vercel/blob";

type Kind = "application" | "availability";
type Submission = { submissionId?: string; universityChoice?: string };
type Receipt = {
  kind: Kind;
  payload: Submission;
  fingerprint: string;
  receivedAt: string;
  status: "queued" | "processing" | "complete" | "failed" | "review_required";
  pendingCreate?: string;
  response?: Record<string, unknown>;
  error?: string;
  diagnostic?: string;
};
export type Checkpoint = (pendingCreate?: string) => Promise<void>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const options = { access: "private" as const, addRandomSuffix: false, contentType: "application/json" };

export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown_failure";
  // Never log Notion response bodies, applicant content, or network URLs.
  return /^[a-z_]+(?:_\d{3})?$/.test(message) ? message : "upstream_failure";
}

async function read(path: string): Promise<{ receipt: Receipt; etag: string } | null> {
  const result = await get(path, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200) return null;
  // GET's HTTP ETag may describe a compressed response. Conditional writes need the storage ETag.
  const metadata = await head(path);
  return { receipt: await new Response(result.stream).json(), etag: metadata.etag };
}

export async function withSubmission(
  kind: Kind,
  payload: Submission,
  work: (checkpoint: Checkpoint, receivedAt: string) => Promise<Record<string, unknown>>,
  operatorDiagnostics = false,
): Promise<Response> {
  // Preview credentials and databases are isolated; production storage is never used there.
  if (process.env.VERCEL_ENV !== "production") {
    try { return Response.json(await work(async () => {}, new Date().toISOString())); }
    catch (error) { return failure(error, false); }
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) return failure(new Error("recovery_unavailable"), false);
  const campus = payload.universityChoice === "bc" ? "bc" : "bu";
  const path = `submissions/v1/${campus}/${kind}/${hash(payload.submissionId!)}.json`;
  const lock = `submissions/locks/${campus}.json`;
  // Object key order must not turn an otherwise identical retry into a conflict.
  const fingerprint = hash(canonical(payload));
  let state: { receipt: Receipt; etag: string };
  try {
    const existing = await read(path);
    if (existing) state = existing;
    else {
      const receipt: Receipt = { kind, payload, fingerprint, receivedAt: new Date().toISOString(), status: "queued" };
      try {
        const saved = await put(path, JSON.stringify(receipt), { ...options, allowOverwrite: false });
        state = { receipt, etag: saved.etag };
      } catch {
        // A concurrent request may have won the create. Never overwrite its answers.
        const winner = await read(path);
        if (!winner) throw new Error("recovery_unavailable");
        state = winner;
      }
    }
    if (state.receipt.fingerprint !== fingerprint) return failure(new Error("submission_conflict"), true);
    if (state.receipt.status === "complete") return Response.json(state.receipt.response);
    if (state.receipt.status === "review_required" || state.receipt.pendingCreate) {
      return failure(new Error("reconciliation_required"), true);
    }
  } catch { return failure(new Error("recovery_unavailable"), false); }

  let lockEtag: string;
  try {
    const acquired = await put(lock, JSON.stringify({ receipt: path, startedAt: new Date().toISOString() }), {
      ...options, allowOverwrite: false,
    });
    lockEtag = acquired.etag;
  } catch { return failure(new Error("submission_pending"), true); }

  const save = async () => {
    const saved = await put(path, JSON.stringify(state.receipt), { ...options, allowOverwrite: true, ifMatch: state.etag });
    state.etag = saved.etag;
  };
  try {
    // Re-read after acquiring the campus lock: another worker may have finished this receipt.
    state = (await read(path))!;
    if (state.receipt.status === "complete") return Response.json(state.receipt.response);
    if (state.receipt.pendingCreate) return failure(new Error("reconciliation_required"), true);
    state.receipt.status = "processing";
    await save();
    const response = await work(async (pendingCreate) => {
      state.receipt.pendingCreate = pendingCreate;
      await save();
    }, state.receipt.receivedAt);
    state.receipt.response = response;
    state.receipt.status = "complete";
    delete state.receipt.error;
    await save();
    return Response.json(response);
  } catch (error) {
    state.receipt.error = safeError(error);
    // Details stay in private storage and are available only to authenticated operators.
    if (error instanceof Error && error.message.startsWith("Vercel Blob:")) {
      let detail = error.message;
      for (const secret of [process.env.BLOB_READ_WRITE_TOKEN, process.env.NOTION_TOKEN, process.env.CRON_SECRET]) {
        if (secret) detail = detail.split(secret).join("[redacted]");
      }
      state.receipt.diagnostic = detail.replace(/https?:\/\/\S+/g, "[url]").replace(/[^\s]+@[^\s]+/g, "[email]").slice(0, 500);
    }
    // A timed-out create may have landed in Notion. Hold it for readback instead of risking a duplicate.
    const definiteRejection = /^notion_4\d\d$/.test(state.receipt.error);
    state.receipt.status = state.receipt.pendingCreate && !definiteRejection ? "review_required" : "failed";
    if (definiteRejection) delete state.receipt.pendingCreate;
    try { await save(); } catch { /* The original durable receipt remains recoverable. */ }
    const errorType = error instanceof Error && ["Error", "TypeError", "TimeoutError", "AbortError", "BlobError", "BlobPreconditionFailedError"].includes(error.name) ? error.name : "UnknownError";
    const frames = error instanceof Error ? (error.stack ?? "").split("\n").slice(1, 4).map(line => line.match(/at ([a-zA-Z0-9_.]+)/)?.[1] ?? "anonymous") : [];
    console.error("submission_sync_failed", kind, campus, state.receipt.error, errorType, frames.join(","));
    const response = failure(error, true);
    if (operatorDiagnostics) return Response.json({ ...await response.json(), diagnostic: state.receipt.diagnostic }, { status: response.status });
    return response;
  } finally {
    // No automatic lock expiry: a crashed writer must be reconciled before a replacement can create pages.
    try { await del(lock, { ifMatch: lockEtag }); } catch { console.error("submission_lock_release_failed", campus); }
  }
}

function failure(error: unknown, recoverable: boolean) {
  const code = safeError(error);
  const conflict = /ambiguous_|conflict|duplicate_submission/.test(code);
  return Response.json({ ok: false, error: conflict ? "identity_conflict" : code,
    recoverable }, { status: conflict ? 409 : 503, headers: { "Retry-After": "10" } });
}

export async function pendingSubmissions(cursor?: string) {
  const page = await list({ prefix: "submissions/v1/", limit: 100, cursor });
  const pending: Receipt[] = [];
  for (const blob of page.blobs) {
    const saved = await read(blob.pathname);
    if (saved && ["queued", "failed"].includes(saved.receipt.status) &&
        !saved.receipt.pendingCreate && !/conflict|ambiguous/.test(saved.receipt.error ?? "")) pending.push(saved.receipt);
    if (pending.length === 3) break;
  }
  return { pending, cursor: page.hasMore ? page.cursor : undefined };
}

export async function submissionDiagnostics() {
  const page = await list({ prefix: "submissions/v1/", limit: 100 });
  const statuses = [];
  for (const blob of page.blobs) {
    const saved = await read(blob.pathname);
    if (saved) statuses.push({ path: blob.pathname, status: saved.receipt.status, error: saved.receipt.error, diagnostic: saved.receipt.diagnostic, pendingCreate: saved.receipt.pendingCreate });
  }
  return statuses;
}
