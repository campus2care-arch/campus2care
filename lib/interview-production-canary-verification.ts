import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { Sql } from "postgres";
import {
  assertProductionVerificationIdentity, assertProductionVerificationRecipient,
  productionVerificationCanaryConfig, productionVerificationCanaryDatabase,
} from "./interview-production-verification-gate";

import { googleProviderAccessToken } from "./interview-google-provider-auth";
import { renderInterviewMessage } from "./interview-email";
import type { Campus } from "./interview-notion-contract";

export class ProductionCanaryVerificationError extends Error {
  constructor(public readonly code: string, public readonly status = 409) {
    super(code);
    this.name = "ProductionCanaryVerificationError";
  }
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const validToken = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(value);
const validCode = (value: unknown): value is string =>
  typeof value === "string" && /^\d{6}$/.test(value);

type Applicant = { id: string; campus: Campus; notion_page_id: string;
  email: string; email_verified_at: Date | null; verification_requested_at: Date | null;
  verification_attempts: number; verification_hash: string | null };
type DeliveryInput = { email: string; campus: Campus; code: string; operationKey: string };
type Dependencies = {
  db?: Sql;
  deliver?: (input: DeliveryInput) => Promise<string>;
};

/** Direct Gmail send is quarantined in the DB BEFORE network I/O. Never replay an uncertain send. */
export async function sendProductionCanaryVerificationEmail(
  input: DeliveryInput, transport: typeof fetch = fetch,
): Promise<string> {
  productionVerificationCanaryConfig();
  if (!productionVerificationCanaryConfig().emailSendsApproved) {
    throw new ProductionCanaryVerificationError("verification_sends_not_approved", 403);
  }
  assertProductionVerificationRecipient(input.campus, input.email);
  const rendered = renderInterviewMessage({
    kind: "verification", operationKey: input.operationKey, recipient: input.email,
    campus: input.campus, verificationCode: input.code,
  });
  const accessToken = await googleProviderAccessToken("gmail", transport);
  const hash = digest(input.operationKey);
  const boundary = "c2c_" + hash;
  const mime = [
    "From: Campus2Care <contact@campus2care.org>",
    "To: " + input.email, "Reply-To: contact@campus2care.org",
    "Subject: [TEST] " + rendered.subject,
    "Message-ID: <" + hash + "@campus2care.org>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
    "", "--" + boundary,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64", "",
    Buffer.from(rendered.text).toString("base64"),
    "--" + boundary, 'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64", "",
    Buffer.from(rendered.html).toString("base64"),
    "--" + boundary + "--", "",
  ].join("\r\n");
  let response: Response;
  try {
    response = await transport("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({ raw: Buffer.from(mime).toString("base64url") }),
      cache: "no-store", signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new ProductionCanaryVerificationError("verification_delivery_uncertain", 503);
  }
  if (!response.ok) throw new ProductionCanaryVerificationError("verification_delivery_uncertain", 503);
  let result: { id?: unknown };
  try { result = await response.json(); }
  catch { throw new ProductionCanaryVerificationError("verification_delivery_uncertain", 503); }
  if (typeof result.id !== "string" || !/^[A-Za-z0-9_-]{5,200}$/.test(result.id)) {
    throw new ProductionCanaryVerificationError("verification_delivery_uncertain", 503);
  }
  return result.id;
}

async function findInvitation(tx: Sql, token: string): Promise<Applicant> {
  const result = await tx<Applicant[]>`
    SELECT i.id,i.campus,i.notion_page_id,i.email_verified_at,
      c.email,c.verification_requested_at,c.verification_attempts,c.verification_hash
    FROM interview.invitation i
    JOIN interview.applicant_contact c ON c.invitation_id=i.id
    WHERE i.token_hash=${digest(token)} AND i.revoked_at IS NULL
      AND i.expires_at>now() AND c.opted_out_at IS NULL
    FOR UPDATE OF i,c`;
  const row = result[0];
  if (!row) throw new ProductionCanaryVerificationError("invalid_invitation", 403);
  try { assertProductionVerificationIdentity(row.campus,row.email,row.notion_page_id); }
  catch { throw new ProductionCanaryVerificationError("invalid_invitation", 403); }
  return row;
}

/**
 * Issue a fresh six-digit code to the exact preapproved test email.
 * Only test accounts, no broader enrollment or invitation campaigns.
 * Records uncertain provider attempts before network I/O.
 */
export async function requestProductionCanaryVerification(
  token: string, deps: Dependencies = {},
): Promise<{ sent: true }> {
  productionVerificationCanaryConfig();
  if (!productionVerificationCanaryConfig().emailSendsApproved) {
    throw new ProductionCanaryVerificationError("verification_sends_not_approved", 403);
  }
  if (!validToken(token)) throw new ProductionCanaryVerificationError("invalid_invitation", 403);
  const db = deps.db ?? productionVerificationCanaryDatabase();
  const operationKey = "interview-mail:verification:" + randomUUID();
  const code = String(randomInt(100000, 1000000));
  const prepared = await db.begin(async tx => {
    const row = await findInvitation(tx, token);
    if (row.email_verified_at) throw new ProductionCanaryVerificationError("already_verified");
    if (row.verification_requested_at &&
        Date.now() - new Date(row.verification_requested_at).getTime() < 60000) {
      throw new ProductionCanaryVerificationError("verification_rate_limited", 429);
    }
    const counts = await tx<{ total: number }[]>`
      SELECT count(*)::int AS total FROM interview.message
      WHERE kind='verification' AND recipient_ref=${row.email}
        AND created_at>now()-interval '7 days'`;
    if ((counts[0]?.total ?? 0) >= 1) {
      throw new ProductionCanaryVerificationError("verification_daily_limit", 429);
    }
    await tx`UPDATE interview.applicant_contact SET
      verification_hash=${digest(row.id + ":" + code)},
      verification_expires_at=now()+interval '10 minutes',
      verification_attempts=0, verification_requested_at=now()
      WHERE invitation_id=${row.id}`;
    // Deliberately no OTP in message payload or audit trail.
    const messages = await tx<{ id: string }[]>`
      INSERT INTO interview.message
        (operation_key,recipient_ref,kind,campus,object_id,state)
      VALUES (${operationKey},${row.email},'verification',${row.campus},
        ${row.id},'reconcile_required') RETURNING id`;
    if (!messages[0]) throw new ProductionCanaryVerificationError("verification_storage_unavailable", 503);
    return { messageId: messages[0].id, email: row.email, campus: row.campus };
  });
  const deliver = deps.deliver ?? sendProductionCanaryVerificationEmail;
  let gmailId: string;
  try {
    gmailId = await deliver({ email: prepared.email, campus: prepared.campus,
      code, operationKey });
  } catch {
    // Message remains quarantined; no automatic resend of an ambiguous Gmail attempt.
    throw new ProductionCanaryVerificationError("verification_delivery_uncertain", 503);
  }
  const updated = await db<{ id: string }[]>`
    UPDATE interview.message SET state='accepted',gmail_message_id=${gmailId},
      accepted_at=now()
    WHERE id=${prepared.messageId} AND state='reconcile_required'
    RETURNING id`;
  if (!updated.length) throw new ProductionCanaryVerificationError("verification_acceptance_uncertain", 503);
  return { sent: true };
}

/** Verify possession of the email using the code, with five bounded attempts. */
export async function completeProductionCanaryVerification(
  token: string, code: string, deps: Pick<Dependencies, "db"> = {},
): Promise<{ verified: true }> {
  productionVerificationCanaryConfig();
  if (!validToken(token) || !validCode(code)) {
    throw new ProductionCanaryVerificationError("invalid_verification", 403);
  }
  const db = deps.db ?? productionVerificationCanaryDatabase();
  const success = await db.begin(async tx => {
    const row = await findInvitation(tx, token);
    if (row.email_verified_at) return true;
    const fresh = await tx<{ verification_hash: string | null; verification_attempts: number }[]>`
      SELECT verification_hash,verification_attempts FROM interview.applicant_contact
      WHERE invitation_id=${row.id} AND verification_expires_at>now() FOR UPDATE`;
    const state = fresh[0];
    if (!state?.verification_hash || state.verification_attempts>=5) return false;
    const accepted = await tx<{ id: string }[]>`
      SELECT id FROM interview.message WHERE object_id=${row.id}
        AND kind='verification' AND state='accepted'
        AND created_at>now()-interval '10 minutes' LIMIT 1`;
    if (!accepted.length) return false;
    await tx`UPDATE interview.applicant_contact SET verification_attempts=verification_attempts+1
      WHERE invitation_id=${row.id}`;
    const expected = Buffer.from(state.verification_hash);
    const actual = Buffer.from(digest(row.id + ":" + code));
    if (expected.length !== actual.length || !timingSafeEqual(expected,actual)) return false;
    await tx`UPDATE interview.invitation SET email_verified_at=now()
      WHERE id=${row.id} AND email_verified_at IS NULL`;
    await tx`UPDATE interview.applicant_contact SET verification_hash=NULL,
      verification_expires_at=NULL WHERE invitation_id=${row.id}`;
    return true;
  });
  if (!success) throw new ProductionCanaryVerificationError("invalid_verification", 403);
  return { verified: true };
}
