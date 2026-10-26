import { timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { POST as application } from "../../application/route";
import { POST as availability } from "../../availability/route";
import { pendingSubmissions, withSubmission } from "../../../../lib/submission-recovery";

export const maxDuration = 60;
function authorized(request: Request) {
  if (process.env.VERCEL_ENV !== "production" || !process.env.CRON_SECRET) return false;
  const expected = Buffer.from(`Bearer ${process.env.CRON_SECRET}`);
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Vercel Cron and authorized operators use the same replay path. No applicant data is returned.
export async function GET(request: NextRequest) {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { pending, cursor } = await pendingSubmissions(request.nextUrl.searchParams.get("cursor") ?? undefined);
  const statuses: number[] = [];
  for (const receipt of pending) {
    const post = receipt.kind === "application" ? application : availability;
    const response = await post(new NextRequest(new URL(`/api/${receipt.kind}`, request.url), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(receipt.payload),
    }));
    statuses.push(response.status);
  }
  return Response.json({ attempted: statuses.length, completed: statuses.filter(status => status === 200).length, statuses, cursor });
}

// Controlled failure injection is authenticated and restricted to visibly synthetic identities.
export async function POST(request: NextRequest) {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null);
  if (body?.kind !== "application" || typeof body.payload?.email !== "string" ||
      !body.payload.email.endsWith("@example.invalid") ||
      !body.payload.fullName?.startsWith("C2C QA ") ||
      typeof body.payload.submissionId !== "string") {
    return Response.json({ error: "invalid_test" }, { status: 400 });
  }
  return withSubmission("application", body.payload, async () => { throw new Error("notion_503"); });
}
