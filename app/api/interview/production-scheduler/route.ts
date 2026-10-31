import {NextRequest,NextResponse} from "next/server";
import {productionSchedulerAuthorized} from "../../../../lib/interview-production-launch";
import {runProductionInterviewScheduler} from "../../../../lib/interview-production-scheduler";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;

export async function POST(request:NextRequest){
  if(!productionSchedulerAuthorized(request.headers.get("authorization"))){
    return NextResponse.json({ok:false,error:"scheduler_not_authorized"},{status:403,headers:{"Cache-Control":"no-store"}});
  }
  try{
    const result=await runProductionInterviewScheduler();
    return NextResponse.json({ok:result.outcome==="healthy",...result},{
      status:result.outcome==="healthy"?200:503,
      headers:{"Cache-Control":"no-store","Referrer-Policy":"no-referrer"},
    });
  }catch{
    return NextResponse.json({ok:false,error:"production_scheduler_failed"},{status:503,headers:{"Cache-Control":"no-store"}});
  }
}
