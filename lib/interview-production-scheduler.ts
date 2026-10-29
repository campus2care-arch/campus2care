import type {Sql} from 'postgres';
import {productionRealConfig} from './interview-production-launch';
import {productionInterviewDatabase} from './interview-production-db';
import {processProductionCanaryOutbox} from './interview-production-worker';
import {dueInterviewDispatches} from './interview-dispatch-policy';
import {queueDueProductionStaffEmails,processProductionStaffOutbox} from './interview-production-staff-mail';

/** Production-only runner. Never use the synthetic preview database or mailer. */
export function productionSchedulerReady(env:Record<string,string|undefined>=process.env){
  productionRealConfig(env);
  if(env.INTERVIEW_PRODUCTION_SCHEDULER_ENABLED!=='true')throw Error('production_scheduler_disabled');
  return {reminders:env.INTERVIEW_REAL_REMINDERS_APPROVED==='true',
    staff:env.INTERVIEW_REAL_STAFF_EMAILS_APPROVED==='true'};
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
export async function runProductionInterviewScheduler(now=new Date(),dependencies:{db?:Sql;worker?:typeof processProductionCanaryOutbox}={}){
  const config=productionSchedulerReady();
  const db=dependencies.db??productionInterviewDatabase();
  const due=dueInterviewDispatches(now);
  const blocked=due.map(x=>x.kind).filter(x=>x.startsWith('applicant_')||
    (!config.staff&&(x.startsWith('ea_')||x==='leadership_escalation')));
  const queued=config.reminders?await queueProductionAppointmentReminders(db,now):0;
  const staffQueued=config.staff?await queueDueProductionStaffEmails(db,now):0;
  const processed=await (dependencies.worker??processProductionCanaryOutbox)(5,{db});
  const staffProcessed=config.staff?await processProductionStaffOutbox(db,4):{claimed:0,done:0,reconciliation:0};
  const outcome=processed.reconciliation===0&&staffProcessed.reconciliation===0&&blocked.length===0?'healthy':'needs_attention';
  await db`INSERT INTO interview.audit_event(actor_ref,action,object_type,object_id,outcome,metadata)
    VALUES('production_scheduler','heartbeat','runtime','production',${outcome},
      ${db.json({queuedReminders:queued,staffQueued,worker:processed,staffWorker:staffProcessed,unimplementedDispatchKinds:blocked})})`;
  return {checkedAt:now.toISOString(),queuedReminders:queued,staffQueued,processed,staffProcessed,unimplementedDispatchKinds:blocked,outcome};
}
