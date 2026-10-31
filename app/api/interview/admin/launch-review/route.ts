import {NextRequest} from 'next/server';
import {interviewAdminGuard,interviewPrivateReply} from '../../../../../lib/interview-admin-api';
import {interviewDatabase} from '../../../../../lib/interview-db';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(request:NextRequest){const guard=interviewAdminGuard(request);if(guard)return guard;
 try{const reviews=await interviewDatabase()`SELECT run_key,reviewed_at,candidate_count,eligible_count,suppressed_count,state,production_url,first_available_at,release_gates,gmail_message_ids FROM interview.launch_review ORDER BY reviewed_at DESC LIMIT 1`;
 return interviewPrivateReply({ok:true,review:reviews[0]??null});}catch{return interviewPrivateReply({ok:false,error:'launch_review_unavailable'},503);}}
