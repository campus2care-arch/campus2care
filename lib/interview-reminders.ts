import {interviewDatabase} from "./interview-db";

/** Transactional appointment notices, independent of routine invitation campaigns. */
export async function queueSyntheticAppointmentReminders(){
  if(process.env.VERCEL_ENV!=="preview"||process.env.INTERVIEW_SYNTHETIC_DISPATCH_ENABLED!=="true")throw new Error("synthetic_dispatch_disabled");
  return interviewDatabase().begin(async tx=>{
    const appointments=await tx<{id:string;campus:string;starts_at:Date;meet_url:string;email:string}[]>`
      SELECT r.id,r.campus,r.starts_at,r.meet_url,c.email FROM interview.reservation r
      JOIN interview.applicant_contact c ON c.invitation_id=r.invitation_id
      WHERE r.notion_page_id LIKE 'synthetic-%' AND r.status='confirmed' AND r.meet_url IS NOT NULL
        AND r.starts_at>now()+interval '30 minutes' AND r.starts_at<=now()+interval '24 hours'
        AND c.opted_out_at IS NULL AND c.email LIKE '%@example.invalid'
      ORDER BY r.starts_at LIMIT 200 FOR UPDATE OF r,c`;
    let queued=0;
    for(const appointment of appointments){
      const key='interview-reminder:'+appointment.id+':'+appointment.starts_at.getTime();
      const messages=await tx<{id:string}[]>`INSERT INTO interview.message(operation_key,recipient_ref,kind,campus,object_id,payload)
        VALUES(${key},${appointment.email},'appointment_reminder',${appointment.campus},${appointment.id},${tx.json({kind:'appointment_reminder',campus:appointment.campus,startsAt:appointment.starts_at.toISOString(),meetUrl:appointment.meet_url})})
        ON CONFLICT DO NOTHING RETURNING id`;
      if(!messages.length)continue;
      await tx`INSERT INTO interview.integration_outbox(operation_key,provider,action,object_id)
        VALUES(${key},'gmail','send_message',${messages[0].id}) ON CONFLICT DO NOTHING`;
      queued++;
    }
    return queued;
  });
}
