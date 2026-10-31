import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import {
  assertProductionVerificationIdentity, productionVerificationCanaryConfig,
  productionVerificationCanaryDatabase,
} from "./interview-production-verification-gate";

import { verifyLiveCanaryApplicant } from "./interview-production-notion";
import type { Campus } from "./interview-notion-contract";

export class ProductionCanaryInvitationError extends Error {
  constructor(public readonly code: string, public readonly status = 409) {
    super(code);
    this.name = "ProductionCanaryInvitationError";
  }
}

type Request = { campus: Campus; email: string; pageId: string };
type Dependencies = {
  db?: Sql;
  verifyApplicant?: typeof verifyLiveCanaryApplicant;
  now?: number;
};
const HOUR = 60 * 60 * 1000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * Founder-only invitation issuance for an exact allowlisted Notion test record.
 * No email verification bypass, outreach, Calendar event or Notion write.
 * The token is returned once, only to the authenticated admin endpoint.
 */
export async function issueProductionCanaryInvitation(
  input: Request, deps: Dependencies = {},
) {
  productionVerificationCanaryConfig();
  let identity: ReturnType<typeof assertProductionVerificationIdentity>;
  try {
    identity = assertProductionVerificationIdentity(input.campus, input.email, input.pageId);
  } catch {
    throw new ProductionCanaryInvitationError("canary_identity_denied", 403);
  }
  const secret = process.env["INTERVIEW_AUTH_SECRET"] ?? "";
  if (secret.length < 32) throw new ProductionCanaryInvitationError("canary_auth_unconfigured", 503);
  const verify = deps.verifyApplicant ?? verifyLiveCanaryApplicant;
  await verify({ campus: identity.campus, email: identity.email, pageId: identity.pageId }, { verificationOnly: true });

  const db = deps.db ?? productionVerificationCanaryDatabase();
  const issuedAt = deps.now ?? Date.now();
  const expiresAt = new Date(issuedAt + 24 * HOUR);
  const token = randomBytes(32).toString("base64url");
  const id = randomUUID();
  const recipientHmac = createHmac("sha256", secret)
    .update("recipient:" + identity.email).digest("hex");

  await db.begin(async tx => {
    // A transactional advisory lock prevents concurrent reissues of the same test page.
    const identityKey = identity.campus + ":" + identity.pageId;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${identityKey},0))`;
    const active = await tx<{ id: string }[]>`
      SELECT id FROM interview.invitation
      WHERE campus=${identity.campus} AND notion_page_id=${identity.pageId}
        AND revoked_at IS NULL AND expires_at>now() LIMIT 1 FOR UPDATE`;
    if (active.length) throw new ProductionCanaryInvitationError("canary_invitation_already_active");

    const reservations = await tx<{ id: string }[]>`
      SELECT id FROM interview.reservation
      WHERE campus=${identity.campus} AND notion_page_id=${identity.pageId}
        AND status IN ('held','calendar_pending','confirmed','reschedule_pending',
          'cancel_pending','reconcile_required') LIMIT 1 FOR UPDATE`;
    if (reservations.length) throw new ProductionCanaryInvitationError("canary_booking_already_active");

    const recent = await tx<{ total: number }[]>`
      SELECT count(*)::int AS total FROM interview.invitation
      WHERE campus=${identity.campus} AND notion_page_id=${identity.pageId}
        AND created_at>now()-interval '1 day'`;
    if ((recent[0]?.total ?? 0) >= 3) {
      throw new ProductionCanaryInvitationError("canary_invitation_daily_limit", 429);
    }

    await tx`INSERT INTO interview.invitation
      (id,campus,notion_page_id,recipient_hmac,token_hash,expires_at)
      VALUES(${id},${identity.campus},${identity.pageId},${recipientHmac},
        ${hash(token)},${expiresAt.toISOString()}::timestamptz)`;
    await tx`INSERT INTO interview.applicant_contact (invitation_id,email)
      VALUES (${id},${identity.email})`;
    await tx`INSERT INTO interview.audit_event
      (actor_ref,action,object_type,object_id,outcome,metadata)
      VALUES ('president@campus2care.org','issue_production_canary_invitation',
        'invitation',${id},'issued',${tx.json({campus:identity.campus})})`;
  });

  return { invitationId: id, invitationToken: token, campus: identity.campus,
    expiresAt: expiresAt.toISOString(), emailVerified: false };
}
