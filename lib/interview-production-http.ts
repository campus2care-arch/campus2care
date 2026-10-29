import {NextRequest,NextResponse} from "next/server";
import {interviewBaseOrigin} from "./interview-auth";
import {productionRealConfig} from "./interview-production-launch";
import {LiveInterviewError} from "./interview-production-public";
import {ProductionBookingError} from "./interview-production-booking";
import {ProductionRealVerificationError} from "./interview-production-real-verification";

type Input=Record<string,unknown>;
export async function handleLiveInterviewRequest(
  request:NextRequest,operation:(input:Input)=>Promise<Record<string,unknown>>,
){
  const reply=(status:number,error:string)=>NextResponse.json({ok:false,error},{
    status,headers:{"Cache-Control":"no-store","Referrer-Policy":"no-referrer",
      "X-Content-Type-Options":"nosniff"}});
  try{productionRealConfig();}catch{return reply(404,"interview_booking_disabled");}
  try{
    if(request.headers.get("origin")!==interviewBaseOrigin(request) ||
       !request.headers.get("content-type")?.startsWith("application/json"))
      return reply(403,"invalid_request_origin");
    const raw=await request.text();
    if(raw.length>3000)return reply(413,"request_too_large");
    const input=JSON.parse(raw) as Input;
    if(!input||typeof input!=="object"||Array.isArray(input))
      return reply(400,"invalid_request");
    const result=await operation(input);
    return NextResponse.json({ok:true,...result},{headers:{
      "Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff"}});
  }catch(error){
    if(error instanceof SyntaxError)return reply(400,"invalid_request");
    if(error instanceof LiveInterviewError||error instanceof ProductionBookingError||
       error instanceof ProductionRealVerificationError)
      return reply(error.status,error.code);
    return reply(503,"interview_booking_unavailable");
  }
}
