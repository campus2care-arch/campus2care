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
    // A blocked dispatch (no approved batch, reminders off) is reported in the body, not as
    // an HTTP failure; only a thrown scheduler error is a 503 for the cron to flag.
    return NextResponse.json({ok:true,...result},{
      status:200,
      headers:{"Cache-Control":"no-store","Referrer-Policy":"no-referrer"},
    });
  }catch{
    return NextResponse.json({ok:false,error:"production_scheduler_failed"},{status:503,headers:{"Cache-Control":"no-store"}});
  }
}
