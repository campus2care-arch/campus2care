import type {Sql} from 'postgres';
import {productionRealConfig} from './interview-production-launch';
import {productionInterviewDatabase} from './interview-production-db';
import {processProductionCanaryOutbox} from './interview-production-worker';
import {dueInterviewDispatches} from './interview-dispatch-policy';
import {queueDueProductionStaffEmails,processProductionStaffOutbox} from './interview-production-staff-mail';
import {queueApprovedApplicantCampaign} from './interview-production-campaign-queue';
import {processProductionCampaignOutbox} from './interview-production-campaign-mail';

/** Production-only runner. Never use the synthetic preview database or mailer. */
export function productionSchedulerReady(env:Record<string,string|undefined>=process.env){
  productionRealConfig(env);
  if(env.INTERVIEW_PRODUCTION_SCHEDULER_ENABLED!=='true')throw Error('production_scheduler_disabled');
  return {reminders:env.INTERVIEW_REAL_REMINDERS_APPROVED==='true',
    staff:env.INTERVIEW_REAL_STAFF_EMAILS_APPROVED==='true',
    applicants:env.INTERVIEW_PRODUCTION_APPLICANT_CAMPAIGNS_ENABLED==='true'&&
      env.INTERVIEW_REAL_APPLICANT_SENDS_APPROVED==='true'};
}

/** Durable 24-hour notices. A unique operation key survives overlapping cron invocations. */
export async function queueProductionAppointmentReminders(db:Sql,now=new Date()):Promise<number>{
  if(process.env.INTERVIEW_REAL_REMINDERS_APPROVED!=='true')throw Error('reminders_not_authorized');
  return db.begin(async tx=>{
    const rows=await tx<{id:string;campus:'BU'|'BC';starts_at:Date;meet_url:string;email:string}[]>`
      SELECT r.id,r.campus,r.starts_at,r.meet_url,c.email
      FROM interview.reservation r JOIN interview.invitation i ON i.id=r.invitation_id
      JOIN interview.applicant_contact c ON c.invitation_id=i.id
      WHERE r.status='confirmed' AND r.meet_url IS NOT NULL AND i.revoked_at IS NULL
        AND c.opted_out_at IS NULL
        AND r.starts_at>${now.toISOString()}::timestamptz+interval '20 minutes'
        AND r.starts_at<=${now.toISOString()}::timestamptz+interval '24 hours'
      ORDER BY r.starts_at,r.id LIMIT 100 FOR UPDATE OF r SKIP LOCKED`;
    let queued=0;
    for(const row of rows){
      const key='interview-reminder:'+row.id+':'+row.starts_at.getTime();
      const messages=await tx<{id:string}[]>`
        INSERT INTO interview.message(operation_key,recipient_ref,kind,campus,object_id,payload)
        VALUES(${key},${row.email},'appointment_reminder',${row.campus},${row.id},
          ${tx.json({startsAt:row.starts_at.toISOString(),meetUrl:row.meet_url,campus:row.campus})})
        ON CONFLICT(operation_key) DO NOTHING RETURNING id`;
      if(!messages.length)continue;
      await tx`INSERT INTO interview.integration_outbox(operation_key,provider,action,object_id)
        VALUES(${key},'gmail','send_message',${row.id}) ON CONFLICT(operation_key) DO NOTHING`;
      queued++;
    }
    return queued;
  });
}

/** A heartbeat must never imply unimplemented applicant/staff campaigns were sent. */
export async function runProductionInterviewScheduler(now=new Date(),dependencies:{db?:Sql;worker?:typeof processProductionCanaryOutbox;
  applicantQueue?:typeof queueApprovedApplicantCampaign;
  applicantWorker?:typeof processProductionCampaignOutbox}={}){
  const config=productionSchedulerReady();
  const db=dependencies.db??productionInterviewDatabase();
  const due=dueInterviewDispatches(now);
  const blocked:string[]=due.map(x=>x.kind).filter(x=>
    (!config.applicants&&x.startsWith('applicant_'))||
    (!config.staff&&(x.startsWith('ea_')||x==='leadership_escalation')));
  if(!config.reminders)blocked.push('appointment_reminders_not_approved');
  if(!config.staff)blocked.push('staff_notifications_not_approved');
  const queued=config.reminders?await queueProductionAppointmentReminders(db,now):0;
  const staffQueued=config.staff?await queueDueProductionStaffEmails(db,now):0;
  const campaign=config.applicants
    ?await (dependencies.applicantQueue??queueApprovedApplicantCampaign)(now,{db})
    :{queued:0,skipped:0,blocked:[] as string[]};
  blocked.push(...campaign.blocked);
  const processed=await (dependencies.worker??processProductionCanaryOutbox)(5,{db});
  const staffProcessed=config.staff?await processProductionStaffOutbox(db,4):{claimed:0,done:0,reconciliation:0};
  const applicantProcessed=config.applicants
    ?await (dependencies.applicantWorker??processProductionCampaignOutbox)(db,5)
    :{claimed:0,sent:0,suppressed:0,reconciliation:0};
  // Approval-gated features (reminders, staff email, campaigns without an approved batch) are
  // expected states, not faults. Only work that needs a human to reconcile is a problem.
  const reconciliation=processed.reconciliation+staffProcessed.reconciliation+
    applicantProcessed.reconciliation;
  const outcome=reconciliation===0?'healthy':'needs_attention';
  await db`INSERT INTO interview.audit_event(actor_ref,action,object_type,object_id,outcome,metadata)
    VALUES('production_scheduler','heartbeat','runtime','production',${outcome},
      ${db.json({queuedReminders:queued,staffQueued,applicantQueued:campaign.queued,
        applicantSkipped:campaign.skipped,worker:processed,staffWorker:staffProcessed,
        applicantWorker:applicantProcessed,blockedDispatchKinds:blocked,
        gatedDispatchKinds:blocked,reconciliationRequired:reconciliation})})`;
  return {checkedAt:now.toISOString(),queuedReminders:queued,staffQueued,
    applicantQueued:campaign.queued,applicantSkipped:campaign.skipped,
    processed,staffProcessed,applicantProcessed,blockedDispatchKinds:blocked,
    unimplementedDispatchKinds:blocked,gatedDispatchKinds:blocked,
    reconciliationRequired:reconciliation,outcome};
}

/** Monitoring view of the newest heartbeat. Never returns recipient data or secrets. */
export async function latestProductionHeartbeat(db:Sql=productionInterviewDatabase(),now=new Date()){
  const rows=await db<{created_at:Date;outcome:string;metadata:Record<string,unknown>|null}[]>`
    SELECT created_at,outcome,metadata FROM interview.audit_event
    WHERE actor_ref='production_scheduler' AND action='heartbeat'
    ORDER BY created_at DESC LIMIT 1`;
  const last=rows[0];
  if(!last)return {lastHeartbeatAt:null,ageMinutes:null,outcome:'never_run',reconciliationRequired:0,gated:[] as string[]};
  const meta=last.metadata??{};
  return {lastHeartbeatAt:last.created_at.toISOString(),
    ageMinutes:Math.floor((now.getTime()-last.created_at.getTime())/60000),
    outcome:last.outcome,
    reconciliationRequired:typeof meta.reconciliationRequired==='number'?meta.reconciliationRequired:0,
    gated:Array.isArray(meta.blockedDispatchKinds)?meta.blockedDispatchKinds as string[]:[]};
}
