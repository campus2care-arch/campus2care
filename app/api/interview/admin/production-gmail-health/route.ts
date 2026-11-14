import {NextRequest,NextResponse} from "next/server";
import {staffFromRequest} from "../../../../../lib/interview-auth";
import {readProductionContactGmailHealth} from "../../../../../lib/interview-production-gmail-health";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=30;
const headers={"Cache-Control":"no-store, private","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff"};
const reply=(status:number,data:object)=>NextResponse.json(data,{status,headers});

/** Founder-only read of the contact@ Gmail grant. Does not send mail or write the database. */
export async function GET(request:NextRequest){
  if(process.env.VERCEL_ENV!=="production")return reply(404,{ok:false,error:"not_found"});
  const staff=staffFromRequest(request);
  if(staff?.role!=="admin"||staff.email!=="president@campus2care.org")
    return reply(403,{ok:false,error:"founder_access_required"});
  try{
    const health=await readProductionContactGmailHealth();
    return reply(200,health);
  }catch{
    return reply(503,{ok:false,error:"gmail_health_unavailable",readOnly:true});
  }
}
