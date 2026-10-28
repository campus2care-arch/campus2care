import { createHmac, timingSafeEqual, createPublicKey, verify } from "node:crypto";
import type { NextRequest } from "next/server";

export const SESSION_COOKIE = "c2c_interview_session";
export const GOOGLE_STATE_COOKIE = "c2c_interview_oauth_state";
export const GOOGLE_PKCE_COOKIE = "c2c_interview_oauth_pkce";
export const GOOGLE_RETURN_COOKIE = "c2c_interview_oauth_return";
const SESSION_SECONDS = 8 * 60 * 60;

export type StaffIdentity = { email: string; role: "admin" | "ea" };

const configuredEmails = (value: string | undefined) =>
  new Set((value ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

export function authorizedRole(email: string): StaffIdentity["role"] | null {
  const normalized = email.trim().toLowerCase();
  if (!normalized.endsWith("@campus2care.org")) return null;
  const admins = configuredEmails(process.env.INTERVIEW_ADMIN_EMAILS);
  admins.add("president@campus2care.org");
  if (admins.has(normalized)) return "admin";
  if (configuredEmails(process.env.INTERVIEW_EA_EMAILS).has(normalized)) return "ea";
  return null;
}

function signingKey(): string {
  const key = process.env.INTERVIEW_AUTH_SECRET ?? "";
  if (key.length < 32) throw new Error("interview_auth_not_configured");
  return key;
}

function sign(data: string): string {
  return createHmac("sha256", signingKey()).update(data).digest("base64url");
}

export function makeSession(email: string, now = Date.now()): string {
  if (!authorizedRole(email)) throw new Error("not_authorized");
  const body = Buffer.from(JSON.stringify({
    v: 1,
    email: email.trim().toLowerCase(),
    expiresAt: Math.floor(now / 1000) + SESSION_SECONDS,
  })).toString("base64url");
  return body + "." + sign(body);
}

export function validateSession(raw: string | undefined, now = Date.now()): StaffIdentity | null {
  if (!raw || raw.length > 4096) return null;
  const sections = raw.split(".");
  if (sections.length !== 2) return null;
  try {
    const expected = Buffer.from(sign(sections[0]));
    const actual = Buffer.from(sections[1]);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    const payload = JSON.parse(Buffer.from(sections[0], "base64url").toString("utf8"));
    if (payload.v !== 1 || typeof payload.email !== "string" ||
        !Number.isInteger(payload.expiresAt) || payload.expiresAt <= Math.floor(now / 1000)) return null;
    const role = authorizedRole(payload.email);
    return role ? { email: payload.email, role } : null;
  } catch {
    return null;
  }
}

export function staffFromRequest(req: NextRequest): StaffIdentity | null {
  return validateSession(req.cookies.get(SESSION_COOKIE)?.value);
}

export function interviewBaseOrigin(req: NextRequest): string {
  const configured = process.env.INTERVIEW_BASE_URL;
  if (!configured) throw new Error("interview_origin_not_configured");
  const url = new URL(configured);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" ||
      url.search || url.hash || url.origin !== configured.replace(/\/$/, "")) {
    throw new Error("invalid_interview_origin");
  }
  if (req.nextUrl.origin !== url.origin) throw new Error("untrusted_interview_origin");
  return url.origin;
}

type GoogleIdTokenClaims = {
  iss: string; aud: string; exp: number; iat: number;
  email: string; email_verified: boolean | string;
  hd?: string; sub: string;
};

/** Verify Google's RSA signature and token claims; never trust an unverified OAuth ID token. */
export async function verifyGoogleIdToken(token: string, now = Date.now()): Promise<string> {
  const clientId = process.env.INTERVIEW_GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("interview_oauth_not_configured");
  const pieces = token.split(".");
  if (pieces.length !== 3 || token.length > 16384) throw new Error("invalid_google_token");
  let header: { alg?: string; kid?: string };
  let claims: GoogleIdTokenClaims;
  try {
    header = JSON.parse(Buffer.from(pieces[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(pieces[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid_google_token");
  }
  if (header.alg !== "RS256" || !header.kid || !/^[\w-]+$/.test(header.kid)) {
    throw new Error("invalid_google_token");
  }
  const response = await fetch("https://www.googleapis.com/oauth2/v3/certs", {
    signal: AbortSignal.timeout(8000),
    next: { revalidate: 3600 },
  });
  if (!response.ok) throw new Error("google_keys_unavailable");
  const keys = (await response.json()) as { keys?: Array<JsonWebKey & { kid?: string; kty?: string; use?: string }> };
  const jwk = keys.keys?.find((k) => k.kid === header.kid && k.kty === "RSA" && k.use === "sig");
  if (!jwk) throw new Error("invalid_google_token");
  const key = createPublicKey({ key: jwk, format: "jwk" });
  if (!verify("RSA-SHA256", Buffer.from(pieces[0] + "." + pieces[1]), key, Buffer.from(pieces[2], "base64url"))) {
    throw new Error("invalid_google_token");
  }
  const seconds = Math.floor(now / 1000);
  if (!["accounts.google.com", "https://accounts.google.com"].includes(claims.iss) ||
      claims.aud !== clientId || !Number.isInteger(claims.exp) ||
      claims.exp <= seconds || !Number.isInteger(claims.iat) ||
      claims.iat > seconds + 60 || seconds - claims.iat > 3600 ||
      (claims.email_verified !== true && claims.email_verified !== "true") ||
      typeof claims.sub !== "string" || !claims.sub ||
      claims.hd !== "campus2care.org" ||
      typeof claims.email !== "string" || !authorizedRole(claims.email)) {
    throw new Error("not_authorized");
  }
  return claims.email.trim().toLowerCase();
}
