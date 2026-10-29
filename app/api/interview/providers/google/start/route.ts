import { providerAuthorizationEnabled } from "../../../../../../lib/interview-provider-store";
import { NextRequest, NextResponse } from "next/server";
import { interviewBaseOrigin, staffFromRequest } from "../../../../../../lib/interview-auth";
import { prepareProviderAuthorization, PROVIDER_COOKIE } from "../../../../../../lib/interview-google-provider-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  if (!providerAuthorizationEnabled()) return NextResponse.json({error:"preview_only"},{status:404});
  const staff = staffFromRequest(req);
  if (!staff || staff.role !== "admin") return NextResponse.json({error:"admin_access_required"},{status:403});
  try {
    const origin = interviewBaseOrigin(req);
    const grant = prepareProviderAuthorization(req.nextUrl.searchParams.get("provider") ?? "", origin, staff.email);
    const response = NextResponse.redirect(grant.url);
    response.cookies.set(PROVIDER_COOKIE, grant.cookie, { httpOnly:true,secure:true,sameSite:"lax",path:"/api/interview/providers/google",maxAge:600 });
    response.headers.set("Cache-Control","no-store");
    return response;
  } catch { return NextResponse.json({error:"provider_authorization_not_ready"},{status:503,headers:{"Cache-Control":"no-store"}}); }
}
