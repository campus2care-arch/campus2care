import {NextRequest} from 'next/server';
import {interviewAdminGuard,interviewPrivateReply} from '../../../../../lib/interview-admin-api';
import {staffFromRequest} from '../../../../../lib/interview-auth';
import {correctFounderShift} from '../../../../../lib/interview-founder-schedule';
export const runtime='nodejs';
export async function POST(request:NextRequest){
 const guard=interviewAdminGuard(request);if(guard)return guard;
 try{const raw=await request.text();if(raw.length>5000)return interviewPrivateReply({ok:false,error:'invalid_shift'},400);
  return interviewPrivateReply({ok:true,...await correctFounderShift(JSON.parse(raw),staffFromRequest(request)!.email)});
 }catch(error){const message=error instanceof Error?error.message:'';const known=['invalid_shift','participant_not_authorized','outside_founder_week','founder_access_required','founder_shift_not_found','shift_modified_elsewhere','participant_roster_unavailable','booked_shift_preserved','participant_schedule_conflict'];return interviewPrivateReply({ok:false,error:known.includes(message)?message:'shift_update_failed'},409);}
}
