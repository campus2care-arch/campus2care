import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { interviewDatabase } from "./interview-db";

export type GoogleProvider = "calendar" | "gmail";
export const PROVIDER_COOKIE = "c2c_interview_provider_grant";
export const PROVIDER_CALLBACK = "/api/interview/providers/google/callback";
const providers = {
  calendar: { email: "interviews@campus2care.org", scopes: [
    "https://www.googleapis.com/auth/calendar.events.owned",
    "https://www.googleapis.com/auth/calendar.events.freebusy",
  ] },
  gmail: { email: "contact@campus2care.org", scopes: ["https://www.googleapis.com/auth/gmail.send"] },
};
export function providerDetails(value: string): { provider: GoogleProvider; email: string; scopes: string[] } {
  if (value !== "calendar" && value !== "gmail") throw new Error("invalid_google_provider");
  return { provider: value, ...providers[value] };
}
function requirePreview() {
  if (process.env.VERCEL_ENV !== "preview") throw new Error("provider_auth_preview_only");
}
function key(): Buffer {
  requirePreview();
  const value = process.env.INTERVIEW_TOKEN_ENCRYPTION_KEY ?? "";
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error("provider_encryption_not_configured");
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32) throw new Error("provider_encryption_not_configured");
  return decoded;
}
function signature(value: string) {
  const secret = process.env.INTERVIEW_AUTH_SECRET ?? "";
  if (secret.length < 32) throw new Error("provider_auth_not_configured");
  return createHmac("sha256", secret).update(value).digest("base64url");
}
export function prepareProviderAuthorization(provider: string, origin: string, actor: string, now = Date.now()) {
  requirePreview(); key();
  const details = providerDetails(provider);
  const client = process.env.INTERVIEW_GOOGLE_CLIENT_ID;
  if (!client || !process.env.INTERVIEW_GOOGLE_CLIENT_SECRET) throw new Error("provider_auth_not_configured");
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const body = Buffer.from(JSON.stringify({ provider, actor, state, verifier, expires: now + 600000 })).toString("base64url");
  const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  target.search = new URLSearchParams({
    client_id: client, redirect_uri: origin + PROVIDER_CALLBACK,
    response_type: "code", scope: ["openid", "email", ...details.scopes].join(" "),
    state, code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256", access_type: "offline", prompt: "consent select_account",
    login_hint: details.email, hd: "campus2care.org",
  }).toString();
  return { url: target.toString(), cookie: body + "." + signature(body) };
}
export function validateProviderState(cookie: string, state: string, actor: string, now = Date.now()) {
  requirePreview();
  if (!cookie) throw new Error("provider_state_missing");
  if (cookie.length > 4096 || !state) throw new Error("invalid_provider_state");
  const parts = cookie.split(".");
  if (parts.length !== 2) throw new Error("invalid_provider_state");
  const expected = Buffer.from(signature(parts[0])), actual = Buffer.from(parts[1]);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error("invalid_provider_state");
  const value = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  if (value.state !== state || value.actor !== actor || !Number.isInteger(value.expires) ||
      typeof value.verifier !== "string" || value.verifier.length !== 43) {
    throw new Error("invalid_provider_state");
  }
  if (value.expires <= now) throw new Error("provider_state_expired");
  return { ...providerDetails(value.provider), verifier: value.verifier };
}
export function sealProviderToken(provider: GoogleProvider, token: string) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(provider + ":" + providers[provider].email));
  return { ciphertext: Buffer.concat([cipher.update(token, "utf8"), cipher.final()]), iv, tag: cipher.getAuthTag() };
}
export function openProviderToken(provider: GoogleProvider, token: { ciphertext: Buffer; iv: Buffer; tag: Buffer }) {
  const decipher = createDecipheriv("aes-256-gcm", key(), token.iv);
  decipher.setAAD(Buffer.from(provider + ":" + providers[provider].email));
  decipher.setAuthTag(token.tag);
  return Buffer.concat([decipher.update(token.ciphertext), decipher.final()]).toString("utf8");
}
async function providerJson(url: string, init: RequestInit, transport: typeof fetch): Promise<Record<string, unknown>> {
  const response = await transport(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("google_provider_authorization_failed");
  const body = await response.json();
  if (!body || typeof body !== "object") throw new Error("google_provider_invalid_response");
  return body;
}
export async function completeProviderAuthorization(input: {
  cookie: string; state: string; actor: string; code: string; origin: string;
}, transport: typeof fetch = fetch) {
  const details = validateProviderState(input.cookie, input.state, input.actor);
  if (!input.code || input.code.length > 4096) throw new Error("invalid_provider_code");
  const token = await providerJson("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.INTERVIEW_GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.INTERVIEW_GOOGLE_CLIENT_SECRET ?? "", code: input.code,
      redirect_uri: input.origin + PROVIDER_CALLBACK, grant_type: "authorization_code", code_verifier: details.verifier }),
  }, transport);
  const granted = typeof token.scope === "string" ? token.scope.split(" ") : [];
  if (typeof token.access_token !== "string" || typeof token.refresh_token !== "string" ||
      token.refresh_token.length < 20 || !details.scopes.every((scope) => granted.includes(scope))) {
    throw new Error("provider_refresh_token_or_scope_missing");
  }
  const identity = await providerJson("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: "Bearer " + token.access_token },
  }, transport);
  if (identity.email !== details.email || identity.email_verified !== true) throw new Error("provider_account_mismatch");
  const encrypted = sealProviderToken(details.provider, token.refresh_token);
  const sql = interviewDatabase();
  await sql.unsafe(`INSERT INTO interview.google_provider_credential
    (provider, account_email, ciphertext, iv, tag, granted_scopes)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (provider) DO UPDATE SET account_email=EXCLUDED.account_email,
      ciphertext=EXCLUDED.ciphertext, iv=EXCLUDED.iv, tag=EXCLUDED.tag,
      granted_scopes=EXCLUDED.granted_scopes, updated_at=now()`,
    [details.provider, details.email, encrypted.ciphertext, encrypted.iv, encrypted.tag, sql.json(granted)]);
  return details.provider;
}
/** Server-only access token. Never return it from an API response or log it. */
export async function googleProviderAccessToken(provider: GoogleProvider, transport: typeof fetch = fetch): Promise<string> {
  requirePreview();
  const details = providerDetails(provider), sql = interviewDatabase();
  const rows = await sql.unsafe<{ account_email: string; ciphertext: Buffer; iv: Buffer; tag: Buffer; granted_scopes: string[] }[]>(
    "SELECT account_email,ciphertext,iv,tag,granted_scopes FROM interview.google_provider_credential WHERE provider=$1", [provider]);
  const stored = rows[0];
  if (!stored || stored.account_email !== details.email || !details.scopes.every((scope) => stored.granted_scopes.includes(scope))) {
    throw new Error("provider_not_connected");
  }
  const token = await providerJson("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.INTERVIEW_GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.INTERVIEW_GOOGLE_CLIENT_SECRET ?? "", grant_type: "refresh_token",
      refresh_token: openProviderToken(provider, stored) }),
  }, transport);
  if (typeof token.access_token !== "string" || token.access_token.length < 20) throw new Error("provider_token_refresh_failed");
  return token.access_token;
}
