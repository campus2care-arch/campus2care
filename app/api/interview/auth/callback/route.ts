import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  GOOGLE_PKCE_COOKIE, GOOGLE_RETURN_COOKIE, GOOGLE_STATE_COOKIE, SESSION_COOKIE,
  authorizedRole, interviewBaseOrigin, makeSession, verifyGoogleIdToken,
} from "../../../../../lib/interview-auth";
import { interviewStaffEnabled, rosterMember } from "../../../../../lib/interview-staff-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function equal(a: string, b: string): boolean {
  const aBytes = Buffer.from(a);
  const bBytes = Buffer.from(b);
  return aBytes.length === bBytes.length && timingSafeEqual(aBytes, bBytes);
}

export async function GET(req: NextRequest) {
  const clear = (res: NextResponse) => {
    for (const name of [GOOGLE_STATE_COOKIE, GOOGLE_PKCE_COOKIE, GOOGLE_RETURN_COOKIE]) {
      res.cookies.set(name, "", { path: "/api/interview/auth", maxAge: 0 });
    }
    res.headers.set("Cache-Control", "no-store");
    return res;
  };
  try {
    const origin = interviewBaseOrigin(req);
    const state = req.nextUrl.searchParams.get("state") ?? "";
    const savedState = req.cookies.get(GOOGLE_STATE_COOKIE)?.value ?? "";
    const verifier = req.cookies.get(GOOGLE_PKCE_COOKIE)?.value ?? "";
    const code = req.nextUrl.searchParams.get("code") ?? "";
    if (!state || !savedState || !equal(state, savedState) || !verifier || !code ||
        req.nextUrl.searchParams.has("error")) throw new Error("invalid_oauth_response");
    const clientId = process.env.INTERVIEW_GOOGLE_CLIENT_ID ?? "";
    const clientSecret = process.env.INTERVIEW_GOOGLE_CLIENT_SECRET ?? "";
    if (!clientId || !clientSecret) throw new Error("interview_oauth_not_configured");
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: clientId, client_secret: clientSecret,
        redirect_uri: origin + "/api/interview/auth/callback",
        grant_type: "authorization_code", code_verifier: verifier,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!tokenResponse.ok) throw new Error("oauth_exchange_failed");
    const data = await tokenResponse.json() as { id_token?: string };
    if (!data.id_token) throw new Error("oauth_missing_identity");
    // A verified campus2care.org account may sign in when it is on the founder-managed
    // interviewer roster in the database, not only when listed in configuration.
    const rosterAllowed = interviewStaffEnabled();
    const email = await verifyGoogleIdToken(data.id_token, Date.now(), { allowRosterCandidates: rosterAllowed });
    const viaRoster = !authorizedRole(email);
    if (viaRoster && !(rosterAllowed && await rosterMember(email))) throw new Error("not_authorized");
    const destination = req.cookies.get(GOOGLE_RETURN_COOKIE)?.value;
    const safeDestination = destination === "/interview/admin" ? destination : "/interview/staff/availability";
    const res = NextResponse.redirect(origin + safeDestination);
    res.cookies.set(SESSION_COOKIE, makeSession(email, Date.now(), { roster: viaRoster }), {
      httpOnly: true, secure: true, sameSite: "lax", path: "/",
      maxAge: 8 * 60 * 60,
    });
    return clear(res);
  } catch {
    const origin = process.env.INTERVIEW_BASE_URL;
    const fallback = origin && /^https:\/\//.test(origin) ? origin.replace(/\/$/, "") : req.nextUrl.origin;
    return clear(NextResponse.redirect(fallback + "/interview/staff/availability?auth=failed"));
  }
}
