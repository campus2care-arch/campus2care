import { createHash, randomBytes, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { interviewBaseOrigin, staffFromRequest } from "../../../../../lib/interview-auth";
import { interviewDatabase } from "../../../../../lib/interview-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function reply(body: object, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Explicitly president-initiated synthetic invitation. This endpoint cannot
 * address a real applicant, email a person, edit Notion, or create a Calendar
 * event. It is intentionally unusable in production.
 */
export async function POST(req: NextRequest) {
  if (process.env.VERCEL_ENV !== "preview" ||
      process.env.INTERVIEW_BOOKING_ENABLED !== "true" ||
      process.env.INTERVIEW_OUTREACH_ENABLED === "true" ||
      process.env.INTERVIEW_CALENDAR_WRITES_ENABLED === "true") {
    return reply({ ok: false, error: "synthetic_booking_not_enabled" }, 404);
  }
  if (staffFromRequest(req)?.role !== "admin") {
    return reply({ ok: false, error: "admin_access_required" }, 403);
  }
  try {
    const origin = interviewBaseOrigin(req);
    if (req.headers.get("origin") !== origin ||
        !req.headers.get("content-type")?.startsWith("application/json")) {
      return reply({ ok: false, error: "invalid_request_origin" }, 403);
    }
    const raw = await req.text();
    if (raw.length > 1000) return reply({ ok: false, error: "request_too_large" }, 413);
    const input = JSON.parse(raw) as { campus?: unknown };
    if (!input || input.campus !== "BU") {
      return reply({ ok: false, error: "synthetic_bu_only" }, 400);
    }

    const db = interviewDatabase();
    const capacity = await db<{ ready: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM interview.interviewer i
        JOIN interview.interviewer_week w ON w.interviewer_id = i.id
        WHERE lower(i.workspace_email) = 'bob@campus2care.org'
          AND i.active AND i.weekly_capacity_limit > 0
          AND 'BU' = ANY(i.allowed_campuses)
          AND w.status = 'confirmed' AND w.confirmed_at IS NOT NULL
          AND w.week_start >= ((now() AT TIME ZONE 'America/New_York')::date - 7)
          AND w.week_start < ((now() AT TIME ZONE 'America/New_York')::date + 35)
      ) AS ready
    `;
    if (!capacity[0]?.ready) {
      return reply({ ok: false, error: "bob_has_no_active_confirmed_capacity" }, 409);
    }

    const active = await db<{ total: number }[]>`
      SELECT count(*)::int AS total FROM interview.invitation
      WHERE notion_page_id LIKE 'synthetic-%'
        AND created_at > now() - interval '1 hour'
    `;
    if ((active[0]?.total ?? 0) >= 5) {
      return reply({ ok: false, error: "synthetic_invitation_limit_reached" }, 429);
    }

    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const recipientRef = randomBytes(32).toString("hex");
    const syntheticRecord = "synthetic-" + randomUUID();
    const inserted = await db<{ expires_at: Date }[]>`
      INSERT INTO interview.invitation (
        campus, notion_page_id, recipient_hmac, token_hash,
        expires_at, email_verified_at
      )
      VALUES ('BU', ${syntheticRecord}, ${recipientRef}, ${tokenHash},
        now() + interval '60 minutes', now())
      RETURNING expires_at
    `;
    if (!inserted[0]) throw new Error("synthetic_invitation_not_created");
    return reply({
      ok: true,
      url: origin + "/interview#token=" + token,
      expiresAt: inserted[0].expires_at.toISOString(),
      campus: "BU",
      description: "Synthetic applicant only. No email, Notion or Calendar write.",
    }, 201);
  } catch {
    return reply({ ok: false, error: "synthetic_invitation_unavailable" }, 503);
  }
}
