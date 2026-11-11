import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { openProductionCampaignToken, type SealedCampaignToken } from "./interview-production-campaign-crypto";

export async function interviewManagementLink(db: Sql, reservationId: string): Promise<string | undefined> {
  const rows = await db<{ operation_key:string; payload:{token?:SealedCampaignToken}; token_hash:string }[]>`
    SELECT m.operation_key,m.payload,i.token_hash FROM interview.reservation r
    JOIN interview.invitation i ON i.id=r.invitation_id
    JOIN interview.message m ON m.object_id=i.id AND m.kind='invitation' AND m.state='accepted'
    WHERE r.id=${reservationId} AND i.revoked_at IS NULL AND i.email_verified_at IS NOT NULL
    ORDER BY m.accepted_at DESC LIMIT 1`;
  const row=rows[0];
  // Legacy/canary invitations may have no recoverable token. Keep confirmation delivery working.
  if(!row?.payload?.token)return undefined;
  const token=openProductionCampaignToken(row.payload.token,row.operation_key);
  if(createHash("sha256").update(token).digest("hex")!==row.token_hash)
    throw Error("interview_management_token_mismatch");
  const origin=process.env.INTERVIEW_BASE_URL??"https://www.campus2care.org";
  const base=new URL(origin);
  if(base.protocol!=="https:" || base.origin!==origin || base.username || base.password)
    throw Error("interview_management_origin_invalid");
  return base.origin+"/interview#token="+encodeURIComponent(token);
}
