import { NextRequest, NextResponse } from "next/server";
import { interviewBaseOrigin, staffFromRequest } from "./interview-auth";
export function interviewAdminGuard(request:NextRequest): NextResponse | null {
  if (process.env.VERCEL_ENV !== "preview") return NextResponse.json({ok:false,error:"staging_only"},{status:404});
  if (staffFromRequest(request)?.role !== "admin") return NextResponse.json({ok:false,error:"admin_access_required"},{status:403});
  if (request.method !== "GET" && (request.headers.get("origin") !== interviewBaseOrigin(request) || !request.headers.get("content-type")?.startsWith("application/json"))) return NextResponse.json({ok:false,error:"invalid_request_origin"},{status:403});
  return null;
}
export function interviewPrivateReply(body:object,status=200) {
  return NextResponse.json(body,{status,headers:{"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});
}
