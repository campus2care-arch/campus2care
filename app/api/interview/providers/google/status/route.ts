import {NextRequest, NextResponse} from "next/server";
import {interviewBaseOrigin, staffFromRequest} from "../../../../../../lib/interview-auth";
import {googleProviderAccessToken, providerDetails} from "../../../../../../lib/interview-google-provider-auth";
import {providerAuthorizationEnabled} from "../../../../../../lib/interview-provider-store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Refresh and identity checks only. Never return credentials or mutate a calendar/inbox. */
export async function GET(req: NextRequest) {
  if (!providerAuthorizationEnabled()) return NextResponse.json({error:"provider_authorization_disabled"},{status:404});
  if (staffFromRequest(req)?.role !== "admin") return NextResponse.json({error:"admin_access_required"},{status:403});
  try { interviewBaseOrigin(req); }
  catch { return NextResponse.json({error:"untrusted_origin"},{status:403}); }
  const checks = await Promise.all((["calendar","gmail"] as const).map(async provider => {
    const details = providerDetails(provider);
    try {
      await googleProviderAccessToken(provider);
      return {provider, account:details.email, scopes:details.scopes, verified:true};
    } catch {
      return {provider, account:details.email, scopes:details.scopes, verified:false};
    }
  }));
  return NextResponse.json({checks, checkedAt:new Date().toISOString()}, {headers:{"Cache-Control":"no-store"}});
}
