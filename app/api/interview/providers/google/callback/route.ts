import { providerAuthorizationEnabled } from "../../../../../../lib/interview-provider-store";
import { NextRequest, NextResponse } from "next/server";
import { interviewBaseOrigin, staffFromRequest } from "../../../../../../lib/interview-auth";
import { completeProviderAuthorization, PROVIDER_COOKIE } from "../../../../../../lib/interview-google-provider-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  const clear = (response: NextResponse) => {
    response.cookies.set(PROVIDER_COOKIE,"",{httpOnly:true,secure:true,sameSite:"lax",path:"/api/interview/providers/google",maxAge:0});
    response.headers.set("Cache-Control","no-store");
    response.headers.set("Referrer-Policy","no-referrer");
    return response;
  };
  if (!providerAuthorizationEnabled()) return clear(NextResponse.json({error:"preview_only"},{status:404}));
  const staff = staffFromRequest(req);
  if (!staff || staff.role !== "admin") return clear(NextResponse.json({error:"admin_access_required"},{status:403}));
  try {
    const origin = interviewBaseOrigin(req);
    if (req.nextUrl.searchParams.has("error")) throw new Error("consent_declined");
    const provider = await completeProviderAuthorization({ origin,actor:staff.email,
      cookie:req.cookies.get(PROVIDER_COOKIE)?.value ?? "",state:req.nextUrl.searchParams.get("state") ?? "",
      code:req.nextUrl.searchParams.get("code") ?? "" });
    return clear(NextResponse.redirect(origin+"/interview/admin?connected="+provider));
  } catch (error) {
    const allowed = new Set(["provider_state_missing", "provider_state_expired", "invalid_provider_state", "provider_account_mismatch", "provider_refresh_token_or_scope_missing", "google_provider_authorization_failed", "google_provider_invalid_response", "provider_encryption_not_configured", "consent_declined"]);
    const reason = error instanceof Error && allowed.has(error.message) ? error.message : "provider_credential_storage_failed";
    // Only a fixed slug is logged; never log the request URL, code, token or error object.
    console.error("interview_provider_auth_failed", reason);
    return clear(NextResponse.json({error:"provider_authorization_failed",reason,
      message: reason === "provider_state_expired" || reason === "provider_state_missing"
        ? "This authorization session expired or its browser cookie was unavailable. Start a new connection from the leadership dashboard."
        : "The backend connection was not saved. Share the reason code with the administrator."},
      {status:400}));
  }
}
