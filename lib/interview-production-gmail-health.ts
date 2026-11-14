import {productionGoogleAccessToken} from "./interview-production-providers";
import {classifyPreSendFailure} from "./interview-campaign-gmail-disposition";
import {boundedAbortSignal} from "./interview-abort-timeout";

const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

export type ContactGmailHealth = {
  ok: boolean;
  readOnly: true;
  account: "contact@campus2care.org";
  source: "environment" | "database";
  refresh: "ok" | "failed";
  gmailSend: boolean;
  errorClass: string | null;
  errorCode: string | null;
  httpStatus: number | null;
  checkedAt: string;
};

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * Refreshes the same contact@ grant the campaign sender uses and checks gmail.send.
 * Never calls Gmail messages.send and never returns a token.
 */
export async function readProductionContactGmailHealth(
  transport: typeof fetch = fetch,
): Promise<ContactGmailHealth> {
  const refresh = process.env.INTERVIEW_PRODUCTION_GMAIL_REFRESH_TOKEN ?? "";
  const source: ContactGmailHealth["source"] = refresh.length >= 20 ? "environment" : "database";
  const checkedAt = new Date().toISOString();
  let tokenStatus: number | null = null;
  let scope = "";
  const wrapped: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    if (url.startsWith(SEND_URL) || url.includes("/messages/send")) {
      throw Error("gmail_health_refuses_send");
    }
    const response = await transport(input, init);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      tokenStatus = response.status;
      try {
        const body = await response.clone().json() as {scope?: unknown};
        if (typeof body?.scope === "string") scope = body.scope;
      } catch { /* The token helper still reads the original body. */ }
    }
    return response;
  };
  const base = {
    readOnly: true as const,
    account: "contact@campus2care.org" as const,
    source, checkedAt,
  };
  let access = "";
  try {
    access = await productionGoogleAccessToken("gmail", wrapped);
  } catch (error) {
    if (error instanceof Error && error.message === "gmail_health_refuses_send") throw error;
    const failure = classifyPreSendFailure(error);
    return {...base, ok:false, refresh:"failed", gmailSend:false,
      errorClass: failure.errorClass, errorCode: failure.code, httpStatus: failure.httpStatus ?? tokenStatus};
  }
  if (!scope.split(/\s+/).includes(GMAIL_SEND_SCOPE)) {
    try {
      const info = await transport("https://oauth2.googleapis.com/tokeninfo", {
        method: "POST",
        headers: {"Content-Type": "application/x-www-form-urlencoded"},
        body: new URLSearchParams({access_token: access}),
        cache: "no-store",
        signal: boundedAbortSignal(8000),
      });
      tokenStatus = tokenStatus ?? info.status;
      if (info.ok) {
        const body = await info.json() as {scope?: unknown};
        if (typeof body?.scope === "string") scope = body.scope;
      } else if (tokenStatus === null) tokenStatus = info.status;
    } catch { /* Scope stays unconfirmed. No mail is sent. */ }
  }
  const gmailSend = scope.split(/\s+/).includes(GMAIL_SEND_SCOPE);
  return {...base, ok: gmailSend, refresh:"ok", gmailSend,
    errorClass: gmailSend ? null : "oauth_config",
    errorCode: gmailSend ? null : "campaign_gmail_scope_missing",
    httpStatus: tokenStatus};
}
