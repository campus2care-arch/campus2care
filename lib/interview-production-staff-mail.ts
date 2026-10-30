import {createHash} from "node:crypto";
import type {Sql} from "postgres";
import {productionRealConfig} from "./interview-production-launch";
import {productionGoogleAccessToken} from "./interview-production-providers";
import {renderInterviewMessage,type InterviewMessage,type InterviewMessageKind} from "./interview-email";
import {dueInterviewDispatches} from "./interview-dispatch-policy";
import {authorizedRole} from "./interview-auth";

const staffKinds=new Set<InterviewMessageKind>(["ea_request","ea_reminder","leadership_escalation"]);
function staffApproved(){
  productionRealConfig();
  if(process.env.INTERVIEW_REAL_STAFF_EMAILS_APPROVED!=="true")
    throw Error("production_staff_notifications_not_approved");
}
export async function sendProductionStaffMessage(message:InterviewMessage,transport:typeof fetch=fetch){
  staffApproved();
  if(!staffKinds.has(message.kind)||!/^[a-z0-9._%+-]+@campus2care\.org$/.test(message.recipient))
    throw Error("production_staff_recipient_invalid");
  const view=renderInterviewMessage(message);
  const hash=createHash("sha256").update(message.operationKey).digest("hex");
  const boundary="c2c_"+hash;
  const mime=[
    "From: Campus2Care <contact@campus2care.org>",
    "To: "+message.recipient,
    "Reply-To: contact@campus2care.org",
    "Subject: "+view.subject,
    "Message-ID: <"+hash+"@campus2care.org>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="'+boundary+'"',
    "", "--"+boundary,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64","",Buffer.from(view.text).toString("base64"),
    "--"+boundary,'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64","",Buffer.from(view.html).toString("base64"),
    "--"+boundary+"--","",
  ].join("\r\n");
  const access=await productionGoogleAccessToken("gmail",transport);
  let response:Response;
  try{
    response=await transport("https://gmail.googleapis.com/gmail/v1/users/me/messages/send",{
      method:"POST",headers:{Authorization:"Bearer "+access,"Content-Type":"application/json"},
      body:JSON.stringify({raw:Buffer.from(mime).toString("base64url")}),
      cache:"no-store",signal:AbortSignal.timeout(10000),
    });
  }catch{throw Error("production_staff_email_outcome_uncertain");}
  if(!response.ok)throw Error("production_staff_email_outcome_uncertain");
  const data=await response.json() as {id?:unknown};
  if(typeof data.id!=="string"||data.id.length<5)throw Error("production_staff_email_outcome_uncertain");
  return data.id;
}

/** Single day/key record is authoritative, even if the scheduled trigger retries. */
export async function queueDueProductionStaffEmails(db:Sql,now=new Date()):Promise<number>{
  staffApproved();
  let count=0;
  for(const run of dueInterviewDispatches(now)){
    if(!staffKinds.has(run.kind as InterviewMessageKind))continue;
    count+=await db.begin(async tx=>{
      const inserted=await tx<{id:string}[]>`
        INSERT INTO interview.dispatch_run(run_key,job_kind,scheduled_for,state)
        VALUES(${run.runKey},${run.kind},${now.toISOString()},'running')
        ON CONFLICT(run_key) DO NOTHING RETURNING id`;
      if(!inserted.length)return 0;
      const staff=await tx<{id:string;workspace_email:string;status:string|null}[]>`
        SELECT i.id,i.workspace_email,w.status FROM interview.interviewer i
        LEFT JOIN interview.interviewer_week w ON w.interviewer_id=i.id
          AND w.week_start=${run.weekStart}::date
        WHERE i.role='ea' AND i.active AND i.workspace_email LIKE '%@campus2care.org'
        ORDER BY i.id LIMIT 150 FOR UPDATE OF i`;
      const approvedStaff=staff.filter(p=>authorizedRole(p.workspace_email)!==null);
      const missing=approvedStaff.filter(p=>!["confirmed","unavailable"].includes(p.status??""));
      // Leadership is an authorized identity, not necessarily an interviewer row.
      // The dispatch_run UUID owns the escalation message, avoiding fake EA rows.
      const recipients=run.kind==="leadership_escalation"
        ?[{id:inserted[0].id,workspace_email:"president@campus2care.org",status:null}]
        :run.kind==="ea_reminder"?missing:approvedStaff;
      let queued=0;
      for(const person of recipients){
        const key="dispatch:"+run.runKey+":"+person.id;
        const payload={
          link:(process.env.INTERVIEW_BASE_URL??"https://www.campus2care.org")+
            (run.kind==="leadership_escalation"?"/interview/admin":"/interview/staff/availability"),
          missingCount:run.kind==="leadership_escalation"?missing.length:undefined,
        };
        const message=await tx<{id:string}[]>`
          INSERT INTO interview.message(operation_key,recipient_ref,kind,object_id,payload)
          VALUES(${key},${person.workspace_email},${run.kind},${person.id},${tx.json(payload)})
          ON CONFLICT(operation_key) DO NOTHING RETURNING id`;
        if(!message.length)continue;
        await tx`INSERT INTO interview.integration_outbox(operation_key,provider,action,object_id)
          VALUES(${key},'gmail','send_message',${message[0].id})
          ON CONFLICT(operation_key) DO NOTHING`;
        queued++;
      }
      await tx`UPDATE interview.dispatch_run SET state='complete',completed_at=now()
        WHERE id=${inserted[0].id}`;
      return queued;
    });
  }
  return count;
}

/** A Gmail send attempt is first made non-retryable. Uncertain outcomes require
 * manual reconciliation to avoid duplicate employee notifications. */
export async function processProductionStaffOutbox(db:Sql,limit=4,deliver=sendProductionStaffMessage){
  staffApproved();
  if(!Number.isInteger(limit)||limit<1||limit>5)throw Error("invalid_staff_worker_limit");
  let claimed=0,done=0,reconciliation=0;
  for(let i=0;i<limit;i++){
    const selected=await db<{id:string;operation_key:string;message_id:string;
      kind:InterviewMessageKind;recipient_ref:string;payload:{link?:string;missingCount?:number};
      }[]>`WITH candidate AS (
      SELECT j.id FROM interview.integration_outbox j
      JOIN interview.message m ON m.id=j.object_id
      LEFT JOIN interview.interviewer i ON i.id=m.object_id
      LEFT JOIN interview.dispatch_run d ON d.id=m.object_id
      WHERE j.provider='gmail' AND j.action='send_message'
        AND j.operation_key LIKE 'dispatch:%'
        AND m.state='queued' AND m.operation_key=j.operation_key
        AND (
          (m.kind IN ('ea_request','ea_reminder') AND i.role='ea' AND i.active
            AND m.recipient_ref=i.workspace_email)
          OR (m.kind='leadership_escalation'
            AND m.recipient_ref='president@campus2care.org'
            AND d.job_kind='leadership_escalation'
            AND m.operation_key='dispatch:'||d.run_key||':'||d.id::text)
        )
        AND j.state IN ('queued','retry') AND j.next_attempt_at<=now()
      ORDER BY j.next_attempt_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1
    )
    UPDATE interview.integration_outbox j SET state='processing',attempts=j.attempts+1,
      lease_until=now()+interval '120 seconds',updated_at=now()
    FROM candidate,interview.message m
    WHERE j.id=candidate.id AND m.id=j.object_id
    RETURNING j.id,j.operation_key,m.id AS message_id,m.kind,m.recipient_ref,m.payload`;
    const job=selected[0];if(!job)break;
    claimed++;
    if(!authorizedRole(job.recipient_ref)){
      await db`UPDATE interview.message SET state='suppressed' WHERE id=${job.message_id} AND state='queued'`;
      await db`UPDATE interview.integration_outbox SET state='done',lease_until=NULL,
        last_error_code='staff_access_revoked' WHERE id=${job.id}`;
      done++;continue;
    }
    const message=await db<{id:string}[]>`UPDATE interview.message SET state='reconcile_required'
      WHERE id=${job.message_id} AND state='queued' RETURNING id`;
    if(!message.length){
      await db`UPDATE interview.integration_outbox SET state='reconcile_required',
        last_error_code='staff_message_claim_conflict',lease_until=NULL
        WHERE id=${job.id}`;
      reconciliation++;continue;
    }
    try{
      const gmailId=await deliver({
        operationKey:job.operation_key,recipient:job.recipient_ref,kind:job.kind,
        link:job.payload?.link,missingCount:job.payload?.missingCount,
      });
      await db.begin(async tx=>{
        await tx`UPDATE interview.message SET state='accepted',gmail_message_id=${gmailId},accepted_at=now()
          WHERE id=${job.message_id} AND state='reconcile_required'`;
        await tx`UPDATE interview.integration_outbox SET state='done',external_id=${gmailId},
          lease_until=NULL,last_error_code=NULL,updated_at=now() WHERE id=${job.id}`;
      });
      done++;
    }catch{
      await db`UPDATE interview.integration_outbox SET state='reconcile_required',
        last_error_code='staff_mail_outcome_uncertain',lease_until=NULL,updated_at=now()
        WHERE id=${job.id}`;
      reconciliation++;
    }
  }
  return {claimed,done,reconciliation};
}
