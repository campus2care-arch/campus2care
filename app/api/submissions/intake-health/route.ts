import { get, list } from "@vercel/blob";

// Temporary, read-only operational diagnostic. Never return applicants,
// receipt paths, email addresses, identities, submission IDs, or payloads.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type ReceiptShape = {
  kind?: string;
  status?: string;
  error?: string;
  pendingCreate?: string;
};

async function inspectCampus(campus: "bu" | "bc") {
  const lockResult = await get(`submissions/locks/${campus}.json`, {
    access: "private",
    useCache: false,
  });
  let lockAgeMinutes: number | null = null;
  if (lockResult?.statusCode === 200 && lockResult.stream) {
    const data = await new Response(lockResult.stream).json().catch(() => ({}));
    const started = Date.parse(String(data.startedAt ?? ""));
    if (Number.isFinite(started)) {
      lockAgeMinutes = Math.max(0, Math.floor((Date.now() - started) / 60000));
    }
  }
  const summary: Record<string, number> = {};
  const errors: Record<string, number> = {};
  let count = 0;
  let missingOrUnreadable = 0;
  let hasMore = false;
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
    const page = await list({ prefix: `submissions/v1/${campus}/`, limit: 100, cursor });
    const paths = page.blobs.map((blob) => blob.pathname);
    for (let i = 0; i < paths.length; i += 8) {
      await Promise.all(paths.slice(i, i + 8).map(async (path) => {
        try {
          const result = await get(path, { access: "private", useCache: false });
          if (result?.statusCode !== 200 || !result.stream) {
            missingOrUnreadable += 1;
            return;
          }
          const receipt = await new Response(result.stream).json() as ReceiptShape;
          const kind = receipt.kind === "application" ? "application" : "availability";
          const status = ["queued", "processing", "complete", "failed", "review_required"].includes(receipt.status ?? "")
            ? receipt.status! : "other";
          summary[`${kind}_${status}`] = (summary[`${kind}_${status}`] ?? 0) + 1;
          if (receipt.pendingCreate) summary.pending_create = (summary.pending_create ?? 0) + 1;
          if (status !== "complete" && /^[a-z_]+(?:_\d{3})?$/.test(receipt.error ?? "")) {
            errors[receipt.error!] = (errors[receipt.error!] ?? 0) + 1;
          }
          count += 1;
        } catch {
          missingOrUnreadable += 1;
        }
      }));
    }
    hasMore = page.hasMore;
    if (!page.hasMore) break;
    cursor = page.cursor;
  }
  return {
    lockPresent: lockResult?.statusCode === 200,
    lockAgeMinutes,
    receiptsScanned: count,
    truncated: hasMore,
    missingOrUnreadable,
    summary,
    errors,
  };
}

export async function GET() {
  if (process.env.VERCEL_ENV !== "production") {
    return Response.json({ error: "production_only" }, { status: 404 });
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return Response.json({ ok: false, error: "recovery_storage_unconfigured" }, { status: 503 });
  }
  try {
    const [bu, bc] = await Promise.all([inspectCampus("bu"), inspectCampus("bc")]);
    return Response.json({ ok: true, at: new Date().toISOString(), bu, bc }, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch {
    return Response.json({ ok: false, error: "recovery_storage_unavailable" }, {
      status: 503,
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  }
}
