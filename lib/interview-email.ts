import { createHash } from "node:crypto";

export type InterviewMessageKind = "invitation" | "verification" | "confirmation" | "cancellation" |
  "ea_request" | "ea_reminder" | "leadership_escalation";
export type InterviewMessage = {
  operationKey: string; recipient: string; kind: InterviewMessageKind;
  campus?: "BU" | "BC"; startsAt?: string; meetUrl?: string; link?: string;
  verificationCode?: string; missingCount?: number;
};
export class InterviewMailError extends Error {
  constructor(public readonly code: string, public readonly ambiguous: boolean) { super(code); }
}
const titles: Record<InterviewMessageKind, string> = {
  invitation: "Schedule your Campus2Care volunteer interview",
  verification: "Verify your Campus2Care interview email",
  confirmation: "Your Campus2Care interview is confirmed",
  cancellation: "Your Campus2Care interview has been canceled",
  ea_request: "Confirm next week's Campus2Care interview hours",
  ea_reminder: "Reminder: confirm next week's interview hours",
  leadership_escalation: "Campus2Care interview availability needs review",
};
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]!);
}
export function renderInterviewMessage(message: InterviewMessage): { subject: string; text: string; html: string } {
  if (!titles[message.kind] || !/^[a-zA-Z0-9:_-]{8,180}$/.test(message.operationKey)) throw new Error("invalid_interview_message");
  const lines = [titles[message.kind] + "."];
  if (message.campus) lines.push("Campus: " + message.campus + ".");
  if (message.kind === "verification") {
    if (!/^\d{6}$/.test(message.verificationCode ?? "")) throw new Error("invalid_verification_code");
    lines.push("Your verification code is " + message.verificationCode + ". It expires in 10 minutes.");
  }
  if (message.kind === "confirmation" || message.startsAt) {
    if (!message.startsAt || !Number.isFinite(Date.parse(message.startsAt))) throw new Error("invalid_message_time");
    lines.push(new Intl.DateTimeFormat("en-US", { timeZone:"America/New_York", dateStyle:"full", timeStyle:"short" }).format(new Date(message.startsAt)) + " Eastern Time (Boston).");
  }
  if (message.kind === "confirmation") {
    if (!/^https:\/\/meet\.google\.com\/[a-z0-9-]+$/.test(message.meetUrl ?? "")) throw new Error("confirmation_requires_meet");
    lines.push("Your interview lasts 20 minutes. Join Google Meet: " + message.meetUrl);
  }
  if (message.kind === "invitation") lines.push("Choose a 20-minute Google Meet interview. Appointment times use Eastern Time (Boston).");
  if (message.kind === "ea_request" || message.kind === "ea_reminder") lines.push("Confirm your hours or select No interviews this week. Saved templates require weekly confirmation.");
  if (message.kind === "leadership_escalation") {
    if (!Number.isInteger(message.missingCount) || message.missingCount! < 0) throw new Error("invalid_missing_count");
    lines.push(String(message.missingCount) + " active interviewers have not responded for next week. Review capacity before invitations.");
  }
  if (message.link) {
    const target = new URL(message.link);
    const base = new URL(process.env.INTERVIEW_BASE_URL ?? "https://www.campus2care.org");
    if (target.protocol !== "https:" || target.origin !== base.origin || !target.pathname.startsWith("/interview")) throw new Error("invalid_message_link");
    lines.push("Open Campus2Care to schedule, review, cancel, or reschedule: " + target.href);
  }
  lines.push("Campus2Care", "Questions? Reply to this email.");
  return { subject:titles[message.kind], text:lines.join("\n\n"),
    html:'<div style="font-family:Arial,sans-serif;max-width:600px;border-top:5px solid #b3131b;padding:24px"><h1 style="color:#b3131b;font-size:22px">Campus2Care</h1>' + lines.map((line) => "<p>" + escapeHtml(line) + "</p>").join("") + "</div>" };
}

/** Gmail acceptance is not proof of inbox delivery. Unknown sends never retry automatically. */
export async function sendStagingInterviewMessage(message: InterviewMessage, accessToken: string, transport: typeof fetch = fetch): Promise<string> {
  if (process.env.VERCEL_ENV !== "preview" || process.env.INTERVIEW_SYNTHETIC_GMAIL_ENABLED !== "true") throw new InterviewMailError("interview_mail_disabled", false);
  // Synthetic applicant addresses cannot receive mail. All staging messages go only to Bob.
  if (!message.recipient.endsWith("@example.invalid") && message.recipient !== "bob@campus2care.org") throw new InterviewMailError("real_recipient_forbidden", false);
  if (accessToken.length < 20) throw new InterviewMailError("gmail_access_not_granted", false);
  const body = renderInterviewMessage(message);
  const digest = createHash("sha256").update(message.operationKey).digest("hex");
  const boundary = "c2c_" + digest;
  const mime = ["From: Campus2Care <contact@campus2care.org>", "To: bob@campus2care.org", "Reply-To: contact@campus2care.org",
    "Subject: [STAGING] " + body.subject, "Message-ID: <" + digest + "@campus2care.org>", "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="' + boundary + '"', "", "--" + boundary,
    'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", Buffer.from(body.text).toString("base64"), "--" + boundary,
    'Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", Buffer.from(body.html).toString("base64"), "--" + boundary + "--", ""].join("\r\n");
  let response: Response;
  try {
    response = await transport("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method:"POST", headers:{ Authorization:"Bearer " + accessToken, "Content-Type":"application/json" },
      body:JSON.stringify({ raw:Buffer.from(mime).toString("base64url") }), cache:"no-store", signal:AbortSignal.timeout(8000),
    });
  } catch { throw new InterviewMailError("gmail_send_outcome_unknown", true); }
  if (!response.ok) throw new InterviewMailError(response.status === 429 ? "gmail_rate_limited" : "gmail_send_rejected", response.status >= 500);
  let result: { id?: unknown };
  try { result = await response.json(); } catch { throw new InterviewMailError("gmail_response_unknown", true); }
  if (typeof result.id !== "string" || !result.id) throw new InterviewMailError("gmail_response_unknown", true);
  return result.id;
}
