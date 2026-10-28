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
  if (process.env.VERCEL_ENV !== "preview") return clear(NextResponse.json({error:"preview_only"},{status:404}));
  const staff = staffFromRequest(req);
  if (!staff || staff.role !== "admin") return clear(NextResponse.json({error:"admin_access_required"},{status:403}));
  try {
    const origin = interviewBaseOrigin(req);
    if (req.nextUrl.searchParams.has("error")) throw new Error("consent_declined");
    const provider = await completeProviderAuthorization({ origin,actor:staff.email,
      cookie:req.cookies.get(PROVIDER_COOKIE)?.value ?? "",state:req.nextUrl.searchParams.get("state") ?? "",
      code:req.nextUrl.searchParams.get("code") ?? "" });
    return clear(NextResponse.redirect(origin+"/interview/admin?connected="+provider));
  } catch { return clear(NextResponse.json({error:"provider_authorization_failed",message:"Authorization was not saved. Check the selected account, granted permissions, and preview setup."},{status:400})); }
}
