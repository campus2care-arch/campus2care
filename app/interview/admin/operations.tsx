"use client";
import { useState } from "react";
type Snapshot={jobs:Array<{id:string;provider:string;action:string;state:string;attempts:number;last_error_code:string|null}>;bookings:Array<{id:string;status:string;starts_at:string;conflict_reason:string|null}>;messages:Array<{state:string;total:number}>;workerEnabled:boolean;gmailEnabled:boolean};
export default function InterviewOperations(){
  const [gmailEvidence,setGmailEvidence]=useState<Record<string,string>>({});
  const [snapshot,setSnapshot]=useState<Snapshot|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState("");
  async function run(action?:string,jobId?:string){
    setBusy(true);setNotice("");
    try{
      if(action){
        const response=await fetch("/api/interview/admin/worker",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,jobId,gmailMessageId:jobId?gmailEvidence[jobId]:undefined})});
        const result=await response.json();if(!response.ok||!result.ok)throw new Error("Operation could not finish. Refresh status before retrying.");
        setNotice(action==="verify_notion"?result.results.map((r:{campus:string;scheduled:boolean;cleaned:boolean;preserved:boolean})=>`${r.campus}: scheduled ${r.scheduled}, cleaned ${r.cleaned}, assignments preserved ${r.preserved}`).join("; "):action==="dispatch"?`Evaluation complete. Queued ${result.queued}; skipped ${result.skipped}.`:`Processed ${result.claimed} jobs; completed ${result.completed}.`);
      }
      const response=await fetch("/api/interview/admin/operations",{cache:"no-store"});const data=await response.json();
      if(!response.ok||!data.ok)throw new Error("Could not load operational status.");setSnapshot(data);
    }catch(error){setNotice(error instanceof Error?error.message:"Operation failed.");}finally{setBusy(false);}
  }
  return <section className="mb-7 rounded-2xl border border-black/10 bg-white p-5">
    <h2 className="text-lg font-black">Staging operations and recovery</h2>
    <p className="mt-2 text-sm text-stone-600">Calendar tests have no attendees. Test email goes only to Bob. Gmail acceptance does not prove inbox delivery.</p>
    <div className="mt-4 flex flex-wrap gap-3">
      <button className="button button-secondary" disabled={busy} onClick={()=>void run()}>Refresh operations</button>
      <button className="button button-secondary" disabled={busy} onClick={()=>void run("process")}>Process synthetic jobs</button>
      <button className="button button-secondary" disabled={busy} onClick={()=>void run("verify_notion")}>Test synthetic Notion sync</button>
      <button className="button button-secondary" disabled={busy} onClick={()=>void run("dispatch")}>Evaluate scheduled messages</button>
    </div>
    {notice&&<p role="status" className="mt-3 text-sm">{notice}</p>}
    {snapshot&&<div className="mt-4 space-y-3 text-sm">
      <p>Worker: {snapshot.workerEnabled?"enabled":"disabled"}. Test Gmail: {snapshot.gmailEnabled?"enabled":"disabled"}.</p>
      <p>Messages: {snapshot.messages.map((m)=>`${m.total} ${m.state}`).join(", ")||"none"}.</p>
      {snapshot.jobs.map((job)=><div className="rounded-lg bg-stone-50 p-3" key={job.id}>
        <p>{job.provider} / {job.action}: {job.state}, attempt {job.attempts}{job.last_error_code?` (${job.last_error_code})`:""}</p>
        {job.provider==="google_calendar"&&["failed","reconcile_required"].includes(job.state)&&<button className="mt-2 underline" disabled={busy} onClick={()=>void run("reconcile_calendar",job.id)}>Reconcile Calendar job</button>}
        {job.provider==="gmail"&&job.state==="reconcile_required"&&<div className="mt-2 space-y-2"><p>Independently verify this exact message in contact&apos;s Sent folder. Record its Gmail message ID below. This records acceptance and never resends.</p><label className="block">Verified Gmail message ID <input className="ml-2 rounded border p-2" value={gmailEvidence[job.id]??""} onChange={(event)=>setGmailEvidence({...gmailEvidence,[job.id]:event.target.value})}/></label><button className="underline" disabled={busy||!/^[a-f0-9]{8,64}$/i.test(gmailEvidence[job.id]??"")} onClick={()=>void run("record_gmail_acceptance",job.id)}>Record verified Gmail acceptance</button></div>}
      </div>)}
      {snapshot.bookings.map((booking)=><p key={booking.id}>{new Date(booking.starts_at).toLocaleString("en-US",{timeZone:"America/New_York"})} ET: {booking.status}{booking.conflict_reason?` (${booking.conflict_reason})`:""}</p>)}
    </div>}
  </section>;
}
