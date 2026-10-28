import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { interviewDatabase, requireInterviewStagingBooking } from "./interview-db";
import { InterviewBookingError } from "./interview-booking";
import {sealInterviewSecret} from "./interview-secrets";
const hash = (value:string) => createHash("sha256").update(value).digest("hex");
export function applicantRecipientHmac(email:string):string {
  const secret=process.env.INTERVIEW_AUTH_SECRET ?? "";
  if(secret.length<32) throw new Error("interview_auth_not_configured");
  return createHmac("sha256",secret).update("recipient:"+email.trim().toLowerCase()).digest("hex");
}
/** Synthetic identity only. The production applicant intake remains untouched. */
export async function issueSyntheticInterviewInvitation(campus:"BU"|"BC", email:string) {
  requireInterviewStagingBooking();
  if(!["BU","BC"].includes(campus) || !/^[a-z0-9._+-]+@example\.invalid$/.test(email)) throw new InterviewBookingError("synthetic_identity_required");
  const token=randomBytes(32).toString("base64url"), id=randomUUID();
  await interviewDatabase().begin(async(tx)=>{
    await tx`INSERT INTO interview.invitation(id,campus,notion_page_id,recipient_hmac,token_hash,expires_at)
      VALUES(${id},${campus},${"synthetic-"+id},${applicantRecipientHmac(email)},${hash(token)},now()+interval '7 days')`;
    await tx`INSERT INTO interview.applicant_contact(invitation_id,email) VALUES(${id},${email})`;
  });
  return token;
}
export async function requestInterviewEmailVerification(token:string):Promise<void> {
  requireInterviewStagingBooking();
  if(!/^[A-Za-z0-9_-]{32,256}$/.test(token ?? "")) throw new InterviewBookingError("invalid_invitation",403);
  await interviewDatabase().begin(async(tx)=>{
    const rows=await tx<{id:string;email:string;requested_at:Date|null}[]>`SELECT i.id,c.email,c.verification_requested_at AS requested_at
      FROM interview.invitation i JOIN interview.applicant_contact c ON c.invitation_id=i.id
      WHERE i.token_hash=${hash(token)} AND i.revoked_at IS NULL AND i.expires_at>now() AND c.opted_out_at IS NULL FOR UPDATE OF i,c`;
    const invite=rows[0]; if(!invite) throw new InterviewBookingError("invalid_invitation",403);
    if(invite.requested_at && Date.now()-invite.requested_at.getTime()<60000) throw new InterviewBookingError("verification_rate_limited",429);
    const code=String(randomInt(100000,1000000)), key="interview-verify:"+randomUUID();
    await tx`UPDATE interview.applicant_contact SET verification_hash=${hash(invite.id+":"+code)},verification_expires_at=now()+interval '10 minutes',verification_attempts=0,verification_requested_at=now() WHERE invitation_id=${invite.id}`;
    const messages=await tx<{id:string}[]>`INSERT INTO interview.message(operation_key,recipient_ref,kind,object_id,payload)
      VALUES(${key},${invite.email},'verification',${invite.id},${tx.json({kind:"verification",secret:sealInterviewSecret(code,"verification:"+invite.id)})}) RETURNING id`;
    await tx`INSERT INTO interview.integration_outbox(operation_key,provider,action,object_id) VALUES(${key},'gmail','send_message',${messages[0].id})`;
  });
}
export async function verifyInterviewEmail(token:string,code:string):Promise<void> {
  requireInterviewStagingBooking();
  if(!/^[A-Za-z0-9_-]{32,256}$/.test(token ?? "") || !/^\d{6}$/.test(code ?? "")) throw new InterviewBookingError("invalid_verification",403);
  const success=await interviewDatabase().begin(async(tx)=>{
    const rows=await tx<{id:string;verification_hash:string|null;verification_attempts:number}[]>`SELECT i.id,c.verification_hash,c.verification_attempts
      FROM interview.invitation i JOIN interview.applicant_contact c ON c.invitation_id=i.id
      WHERE i.token_hash=${hash(token)} AND i.revoked_at IS NULL AND i.expires_at>now() AND c.opted_out_at IS NULL
        AND c.verification_expires_at>now() FOR UPDATE OF i,c`;
    const row=rows[0]; if(!row?.verification_hash || row.verification_attempts>=5) return false;
    // Count failed attempts in a committed transaction rather than rolling back on rejection.
    await tx`UPDATE interview.applicant_contact SET verification_attempts=verification_attempts+1 WHERE invitation_id=${row.id}`;
    if(!timingSafeEqual(Buffer.from(row.verification_hash),Buffer.from(hash(row.id+":"+code)))) return false;
    await tx`UPDATE interview.invitation SET email_verified_at=now() WHERE id=${row.id}`;
    await tx`UPDATE interview.applicant_contact SET verification_hash=NULL,verification_expires_at=NULL WHERE invitation_id=${row.id}`;
    // Codes are no longer needed after successful verification.
    await tx`UPDATE interview.message SET payload='{}'::jsonb WHERE object_id=${row.id} AND kind='verification' AND state='accepted'`;
    return true;
  });
  if(!success) throw new InterviewBookingError("invalid_verification",403);
}
