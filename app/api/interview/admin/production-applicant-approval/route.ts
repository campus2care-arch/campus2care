import {NextRequest,NextResponse} from "next/server";
import {staffFromRequest,interviewBaseOrigin} from "../../../../../lib/interview-auth";
import {prepareProductionCampaign,commitProductionCampaign,CampaignApprovalError,
 type CampaignApprovalRequest} from "../../../../../lib/interview-production-campaign-approval";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
const headers={"Cache-Control":"no-store, private","Referrer-Policy":"no-referrer",
 "X-Content-Type-Options":"nosniff"};
const reply=(body:object,status=200)=>NextResponse.json(body,{status,headers});
/** Founder-only two-step exact-audience review, NO sending and OFF by default. */
export async function POST(request:NextRequest){
 if(process.env.VERCEL_ENV!=="production")return reply({ok:false,error:"not_found"},404);
 const identity=staffFromRequest(request);
 if(identity?.role!=="admin"||identity.email!=="president@campus2care.org")
   return reply({ok:false,error:"founder_access_required"},403);
 if(request.headers.get("origin")!==interviewBaseOrigin(request)||
    !request.headers.get("content-type")?.startsWith("application/json"))
   return reply({ok:false,error:"invalid_request_origin"},403);
 try{
   const raw=await request.text();
   if(raw.length>30000)return reply({ok:false,error:"request_too_large"},413);
   const body=JSON.parse(raw) as CampaignApprovalRequest & {action?:string};
   if(!body||typeof body!=="object"||Array.isArray(body)||
      !["preview","approve"].includes(body.action??""))
     return reply({ok:false,error:"invalid_request"},400);
   if(body.action==="preview"){
     const review=await prepareProductionCampaign(body);
     return reply({ok:true,action:"preview",canSend:false,runKey:review.runKey,
       approvalDigest:review.approvalDigest,recipientCount:review.recipientCount,
       campusCounts:review.campusCounts});
   }
   const created=await commitProductionCampaign(body);
   return reply({ok:true,action:"approved",...created});
 }catch(error){
   const code=error instanceof CampaignApprovalError?error.code:"campaign_approval_unavailable";
   return reply({ok:false,error:code},409);
 }
}
