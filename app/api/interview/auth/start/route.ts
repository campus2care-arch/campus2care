import { randomBytes, createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { GOOGLE_PKCE_COOKIE, GOOGLE_RETURN_COOKIE, GOOGLE_STATE_COOKIE, interviewBaseOrigin } from "../../../../../lib/interview-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const origin = interviewBaseOrigin(req);
    const clientId = process.env.INTERVIEW_GOOGLE_CLIENT_ID;
    const clientSecret = process.env.INTERVIEW_GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret || !process.env.INTERVIEW_AUTH_SECRET) {
      return NextResponse.json({ error: "interview_oauth_not_configured" }, { status: 503 });
    }
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const allowedDestinations = ["/interview/staff/availability", "/interview/admin"];
    const requested = req.nextUrl.searchParams.get("returnTo") ?? "";
    const destination = allowedDestinations.includes(requested) ? requested : allowedDestinations[0];
    const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    target.searchParams.set("client_id", clientId);
    target.searchParams.set("redirect_uri", origin + "/api/interview/auth/callback");
    target.searchParams.set("response_type", "code");
    target.searchParams.set("scope", "openid email profile");
    target.searchParams.set("state", state);
    target.searchParams.set("code_challenge", challenge);
    target.searchParams.set("code_challenge_method", "S256");
    target.searchParams.set("hd", "campus2care.org");
    target.searchParams.set("prompt", "select_account");
    const res = NextResponse.redirect(target);
    const opts = { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/api/interview/auth", maxAge: 600 };
    res.cookies.set(GOOGLE_STATE_COOKIE, state, opts);
    res.cookies.set(GOOGLE_PKCE_COOKIE, verifier, opts);
    res.cookies.set(GOOGLE_RETURN_COOKIE, destination, opts);
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch {
    return NextResponse.json({ error: "interview_oauth_unavailable" }, { status: 503 });
  }
}
