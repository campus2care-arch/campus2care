"use client";
import {useCallback,useEffect,useMemo,useState} from "react";

type Campus="BU"|"BC";
type Candidate={campus:Campus;pageId:string;recipientHmac:string;name:string;email:string;manualReconciliationRequired:boolean;
  frequencyLimited?:boolean};
type HeldApplicant={campus:Campus;pageId:string;name:string;email:string;decision:string};
type ReasonCounts=Record<string,number>;
type CampaignStatus={runKey:string;state:string;expectedCount:number;expiresAt:string;approvedAt:string;
  queued:number;sent:number;suppressed:number;reconciliation:number;pending:number};
type ReconcileRecipient={runKey:string;campus:Campus;pageId:string;name:string;email:string;
  errorCode:string;outboxState:string;gmailMessageId:string|null};
type StatusBody={ok?:boolean;campaigns?:CampaignStatus[];reconcileRecipients?:ReconcileRecipient[];error?:string};
type ReviewResponse={ok?:boolean;error?:string;candidates?:Candidate[];
  held?:HeldApplicant[];
  scanned?:number;countsByDecision?:ReasonCounts;
  approvalDigest?:string;recipientCount?:number;campusCounts?:{BU:number;BC:number};
  manifestId?:string;expiresAt?:string};
const endpoint="/api/interview/admin/production-applicant-approval";
const statusEndpoint="/api/interview/admin/production-applicant-status";
function upcomingCampaigns(){
  const p=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"})
    .formatToParts(new Date());
  const value=(key:string)=>p.find(x=>x.type===key)?.value??"";
  const local=value("year")+"-"+value("month")+"-"+value("day");
  const today=new Date(local+"T12:00:00Z");
  // Founder may prepare up to three independently reviewed manual waves today.
  // These do not send until the founder presses "Send approved now".
  const choices: {runKey:string;label:string}[]=[1,2,3].map(wave=>({
    runKey:"applicant_manual:"+local+":"+wave,label:"Send when approved · today · wave "+wave
  }));
  const allowed=[{day:5,kind:"friday",label:"Friday · 2 PM"},{day:0,kind:"sunday",label:"Sunday · 5 PM"},
    {day:1,kind:"monday",label:"Monday · 9 AM"}];
  // Server only approves today or tomorrow: no approvals for distant campaigns.
  for(let offset=0;offset<=1;offset++){
    const next=new Date(today);next.setUTCDate(next.getUTCDate()+offset);
    const day=next.getUTCDay(),date=next.toISOString().slice(0,10);
    for(const item of allowed)if(item.day===day)
      choices.push({runKey:"applicant_"+item.kind+":"+date,label:item.label+" Eastern · "+date});
  }
  return choices;
}
function errorLabel(code:string){
  const labels:Record<string,string>={
    audience_review_disabled:"Live pipeline review is not enabled. No applicant records were accessed.",
    campaign_approval_disabled:"Batch approval is not enabled. No manifest was created.",
    campaign_candidate_changed_or_ineligible:"Some records changed or no longer pass the eligibility checks. Applicants marked as recently contacted need a follow-up exception. Refresh the list and review again.",
    campaign_approval_digest_mismatch:"The approved audience or evidence changed. Preview the exact batch again.",
    campaign_run_already_approved:"This campaign already has an approved batch. Refresh campaign status before proceeding.",
    campaign_approval_unavailable:"Approval service unavailable. Do not repeat approval until status has been checked.",
    campaign_cancel_requires_unsent_batch:"This campaign has already started processing. Disable sends and reconcile its status instead.",
    founder_access_required:"Sign in using president@campus2care.org to review the applicant audience.",
    campaign_exceeds_bu_capacity:"More BU applicants selected than open BU interview slots can support. Remove some or add slots.",
    campaign_exceeds_bc_capacity:"More BC applicants selected than open BC interview slots can support. Remove some or add slots.",
    campaign_send_unavailable_or_not_authorized:"Sending is not yet authorized by the production release gates, or the sender is unavailable. No unconfirmed retry will be performed.",
    campaign_not_approved_or_expired:"That exact invitation batch is not approved or has expired. Refresh the status.",
  };
  return labels[code]??code.replaceAll("_"," ");
}
export default function FounderApplicantCampaigns({enabled=false,previewOnly=false}:{
  enabled?:boolean;previewOnly?:boolean;
}){
  const [candidates,setCandidates]=useState<Candidate[]>([]);
  const [held,setHeld]=useState<HeldApplicant[]>([]);
  const [reasons,setReasons]=useState<ReasonCounts>({});
  const [scanned,setScanned]=useState<number|null>(null);
  const [selected,setSelected]=useState<Set<string>>(new Set());
  const [notes,setNotes]=useState<Record<string,string>>({});
  const [exceptions,setExceptions]=useState<Set<string>>(new Set());
  const [campus,setCampus]=useState<"ALL"|Campus>("ALL");
  const [search,setSearch]=useState("");
  const [bulkNote,setBulkNote]=useState("");
  const choices=useMemo(()=>upcomingCampaigns(),[]);
  const [runKey,setRunKey]=useState(choices[0]?.runKey??"");
  const [preview,setPreview]=useState<null|{digest:string;count:number;bu:number;bc:number}>(null);
  const [confirm,setConfirm]=useState(false);
  const [cancelTarget,setCancelTarget]=useState<string|null>(null);
  const [status,setStatus]=useState<CampaignStatus[]>([]);
  const [reconcileRecipients,setReconcileRecipients]=useState<ReconcileRecipient[]>([]);
  const [gmailMessageIds,setGmailMessageIds]=useState<Record<string,string>>({});
  const [gmailConfirmations,setGmailConfirmations]=useState<Set<string>>(new Set());
  const [busy,setBusy]=useState<"refresh"|"preview"|"approve"|"status"|"cancel"|"send"|"reconcile"|null>(null);
  const [error,setError]=useState("");
  const [success,setSuccess]=useState("");
  const key=(c:Candidate)=>c.campus+":"+c.pageId;
  const visible=candidates.filter(c=>(campus==="ALL"||c.campus===campus)&&
    (!search.trim()||c.email.toLowerCase().includes(search.trim().toLowerCase())));
  const approvedCandidates=candidates.filter(c=>selected.has(key(c)));
  const missingNotes=approvedCandidates.filter(c=>(notes[key(c)]??"").trim().length<8);
  const clearPreview=()=>{setPreview(null);setConfirm(false);setSuccess("");};
  const api=async (action:string,body:object={})=>{
    const response=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},
      cache:"no-store",body:JSON.stringify({action,...body})});
    const result=await response.json() as ReviewResponse;
    if(!response.ok||!result.ok)throw Error(result.error??"campaign_approval_unavailable");
    return result;
  };
  const loadStatus=useCallback(async()=>{
    try {
      const response=await fetch(statusEndpoint,{cache:"no-store"});
      const body=await response.json() as StatusBody;
      if(response.ok&&body.ok&&Array.isArray(body.campaigns)){
        setStatus(body.campaigns);
        setReconcileRecipients(Array.isArray(body.reconcileRecipients)?body.reconcileRecipients:[]);
      }
    } catch {/* Availability is optional while the database migration is pending. */}
  },[]);
  useEffect(()=>{
    if(!enabled||previewOnly)return;
    const controller=new AbortController();
    void fetch(statusEndpoint,{cache:"no-store",signal:controller.signal})
      .then(async response=>{
        const body=await response.json() as StatusBody;
        if(!controller.signal.aborted&&response.ok&&body.ok&&Array.isArray(body.campaigns)){
          setStatus(body.campaigns);
          setReconcileRecipients(Array.isArray(body.reconcileRecipients)?body.reconcileRecipients:[]);
        }
      }).catch(()=>{/* The campaign ledger may not be provisioned yet. */});
    return ()=>controller.abort();
  },[enabled,previewOnly]);
  async function refresh(preselect?:string[]){
    setBusy("refresh");setError("");clearPreview();
    setCandidates([]);setSelected(new Set());
    setHeld([]);
    try{
      const result=await api("candidates");
      const loaded=result.candidates??[];
      setCandidates(loaded);
      setHeld(result.held??[]);
      // Keys chosen in the applicant table; only current candidates can be selected.
      if(preselect)setSelected(new Set(loaded.map(key).filter(k=>preselect.includes(k)).slice(0,100)));
      setReasons(result.countsByDecision??{});
      setScanned(result.scanned??0);
      await loadStatus();
    }catch(e){setError(errorLabel(e instanceof Error?e.message:"audience_review_unavailable"));}
    finally{setBusy(null);}
  }
  // The dashboard's Invite buttons hand over applicant keys; the founder still reviews here.
  useEffect(()=>{
    if(!enabled||previewOnly)return;
    const listener=(event:Event)=>{
      const keys=(event as CustomEvent<{keys?:string[]}>).detail?.keys;
      if(Array.isArray(keys))void refresh(keys);
    };
    window.addEventListener("c2c-select-applicants",listener);
    return ()=>window.removeEventListener("c2c-select-applicants",listener);
  });
  const requested=()=>({runKey,recipients:approvedCandidates.map(c=>({
    campus:c.campus,pageId:c.pageId,recipientHmac:c.recipientHmac,
    manualReference:(notes[key(c)]??"").trim(),frequencyException:exceptions.has(key(c))
  }))});
  async function previewBatch(){
    if(!runKey||!approvedCandidates.length||missingNotes.length)return;
    setBusy("preview");setError("");clearPreview();
    try{
      const result=await api("preview",requested());
      if(!result.approvalDigest||result.recipientCount!==approvedCandidates.length)
        throw Error("campaign_approval_unavailable");
      setPreview({digest:result.approvalDigest,count:result.recipientCount,
        bu:result.campusCounts?.BU??0,bc:result.campusCounts?.BC??0});
    }catch(e){setError(errorLabel(e instanceof Error?e.message:"campaign_approval_unavailable"));}
    finally{setBusy(null);}
  }
  async function approve(){
    if(!preview||!confirm||!enabled||previewOnly)return;
    setBusy("approve");setError("");
    try{
      const result=await api("approve",{...requested(),approvalDigest:preview.digest});
      setSuccess("Exact-recipient batch saved for review. No emails were sent. Manifest expires: "+
        (result.expiresAt?new Date(result.expiresAt).toLocaleString():"unknown")+".");
      setPreview(null);setConfirm(false);
      await loadStatus();
    }catch(e){setError(errorLabel(e instanceof Error?e.message:"campaign_approval_unavailable"));}
    finally{setBusy(null);}
  }
  async function sendApprovedNow(manualKey:string){
    if(!enabled||previewOnly||busy||!manualKey.startsWith("applicant_manual:"))return;
    setBusy("send");setError("");setSuccess("");
    try{
      let sent=0,remaining=0,blocked:string[]=[];
      // Every call is limited server-side to five Gmail sends. The database
      // records each acceptance and protects against repeated clicks.
      for(let i=0;i<32;i++){
        const response=await fetch("/api/interview/admin/production-applicant-send-now",{
          method:"POST",headers:{"Content-Type":"application/json"},cache:"no-store",
          body:JSON.stringify({runKey:manualKey}),
        });
        const result=await response.json() as {
          ok?:boolean;error?:string;sent?:number;queued?:number;
          counts?:Record<string,number>;blocked?:string[]
        };
        if(!response.ok||!result.ok)throw Error(result.error??"campaign_send_unavailable_or_not_authorized");
        sent+=result.sent??0;
        remaining=(result.counts?.approved??0)+(result.counts?.queued??0);
        blocked=result.blocked??[];
        if(remaining===0||((result.sent??0)===0&&(result.queued??0)===0))break;
      }
      setSuccess("Gmail accepted "+sent+" invitation(s) during this action. "+
        remaining+" still pending in this approved batch. "+
        (blocked.length?"Checks: "+[...new Set(blocked)].join(", ")+". ":"")+
        "Review the live sent/reconciliation counts below.");
      await loadStatus();
    }catch(e){setError(errorLabel(e instanceof Error?e.message:"campaign_send_unavailable_or_not_authorized"));}
    finally{setBusy(null);}
  }
  async function cancelBatch(runKey:string){
    if(!enabled||previewOnly||busy)return;
    setBusy("cancel");setError("");setSuccess("");
    try{
      await api("cancel",{runKey});
      setSuccess("The untouched batch was canceled. No invitations were sent.");
      setCancelTarget(null);
      await loadStatus();
    }catch(e){
      setError(errorLabel(e instanceof Error?e.message:"campaign_cancel_unavailable"));
    }finally{setBusy(null);}
  }
  const reconcileKey=(person:ReconcileRecipient)=>person.runKey+":"+person.email.toLowerCase();
  async function recordVerifiedAcceptance(person:ReconcileRecipient){
    const id=reconcileKey(person),gmailMessageId=(gmailMessageIds[id]??"").trim();
    if(!gmailConfirmations.has(id)||!gmailMessageId||busy)return;
    setBusy("reconcile");setError("");setSuccess("");
    try{
      const response=await fetch("/api/interview/admin/production-applicant-reconcile",{
        method:"POST",headers:{"Content-Type":"application/json"},cache:"no-store",
        body:JSON.stringify({runKey:person.runKey,email:person.email,gmailMessageId,confirmed:true}),
      });
      const result=await response.json() as {ok?:boolean;error?:string;note?:string};
      if(!response.ok||!result.ok)throw Error(result.error??"campaign_reconciliation_unavailable");
      setSuccess((result.note??"Gmail acceptance recorded.")+" Refreshing campaign counts.");
      setGmailConfirmations(old=>{const next=new Set(old);next.delete(id);return next;});
      await loadStatus();
    }catch(e){setError(errorLabel(e instanceof Error?e.message:"campaign_reconciliation_unavailable"));}
    finally{setBusy(null);}
  }
  return <section id="applicant-invitations" className="mt-8 rounded-2xl border border-black/10 bg-white p-5 text-stone-900 sm:p-7" aria-label="Founder-approved applicant invitations">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <p className="text-xs font-black uppercase tracking-[.15em] text-[#a91e28]">Campus2Care · Founder-only</p>
        <h2 className="mt-2 text-2xl font-black">Applicant invitation approval</h2>
        <p className="mt-2 max-w-2xl text-sm text-stone-600">Review BU and BC applicants, reconcile earlier email correspondence, and approve exactly who may be invited. Approving a batch does not send any emails.</p>
      </div>
      <div className="rounded-full bg-stone-100 px-4 py-2 text-xs font-bold text-stone-700">
        {previewOnly?"Safe preview only":enabled?"Founder review":"Review disabled"}
      </div>
    </div>
    <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
      Real applicant messages are <strong>not activated by this panel</strong>. Your recipient selection and signed approval are separate from the scheduler&apos;s production send authorization. Reconcile past Gmail invitations before selecting anyone.
    </div>
    {(!enabled||previewOnly)&&<p className="mt-4 text-sm text-stone-600" role="status">
      {previewOnly?"This branch can display the approval workflow but is forbidden from reading live applicants in preview deployments.":
      "The applicant-audience feature flag is off. You may inspect the dashboard, but live records cannot be loaded."}
    </p>}
    <div className="mt-5 flex flex-wrap items-center gap-3">
      <button type="button" className="rounded-lg bg-[#a91e28] px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
        disabled={!enabled||previewOnly||busy!==null} onClick={()=>void refresh()}>
        {busy==="refresh"?"Checking…":"Review eligible applicants"}
      </button>
      <button type="button" className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold disabled:opacity-40"
        disabled={!enabled||previewOnly||busy!==null} onClick={()=>{setBusy("status");void loadStatus().finally(()=>setBusy(null));}}>Refresh campaign status</button>
      {scanned!==null&&<span className="text-sm text-stone-600">{scanned} records checked · {candidates.length} need manual email review</span>}
    </div>
    {scanned!==null&&<div className="mt-4 flex flex-wrap gap-2 text-xs">
      {Object.entries(reasons).sort(([a],[b])=>a.localeCompare(b)).map(([name,count])=>
        <span key={name} className="rounded-full bg-stone-100 px-3 py-2">{name.replaceAll("_"," ")}: {count}</span>)}
    </div>}
    {candidates.length>0&&<>
      <div className="mt-7 flex flex-wrap items-end justify-between gap-3">
        <div><h3 className="text-lg font-bold">Recipient review</h3>
          <p className="text-xs text-stone-600">Selected: {approvedCandidates.length} / 100 per campaign · notes missing: {missingNotes.length}</p></div>
        <div className="flex flex-wrap gap-2">
          <select aria-label="Filter by campus" value={campus} onChange={e=>setCampus(e.target.value as "ALL"|Campus)} className="rounded-lg border border-stone-300 px-3 py-2 text-sm">
            <option value="ALL">Both campuses</option><option value="BU">Boston University</option><option value="BC">Boston College</option>
          </select>
          <input aria-label="Filter by applicant email" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search email" className="w-48 rounded-lg border border-stone-300 px-3 py-2 text-sm" />
        </div>
      </div>
      <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50 p-4">
        <p className="text-sm font-semibold">Request all eligible interviews</p>
        <p className="mt-1 text-xs text-stone-600">Selects every eligible applicant shown by the current campus and search filter, up to 100 per campaign, regardless of how many interview slots are currently open. Each one still needs a correspondence-review note before the exact batch can be checked and approved. Nothing is sent from this page.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" disabled={busy!==null||!visible.length}
            className="rounded-lg bg-[#a91e28] px-3 py-2 text-xs font-semibold text-white disabled:opacity-40"
            onClick={()=>{setSelected(new Set(visible.map(key).slice(0,100)));clearPreview();}}>
            Select all eligible shown ({Math.min(visible.length,100)})</button>
          <button type="button" disabled={busy!==null||!selected.size}
            className="rounded-lg border border-stone-300 px-3 py-2 text-xs font-semibold disabled:opacity-40"
            onClick={()=>{setSelected(new Set());clearPreview();}}>Clear selection</button>
        </div>
        <label className="mt-3 block text-xs font-semibold" htmlFor="bulk-evidence">Shared review note for all selected</label>
        <div className="mt-1 flex flex-wrap gap-2">
          <input id="bulk-evidence" value={bulkNote} maxLength={250} onChange={e=>setBulkNote(e.target.value)} disabled={busy!==null}
            placeholder="Example: Checked contact@ and campus2care@gmail on Nov 1; prior invite only, no reply, opt-out or withdrawal."
            className="min-w-0 flex-1 rounded-lg border border-stone-300 p-2 text-sm" />
          <button type="button" disabled={busy!==null||bulkNote.trim().length<8||!selected.size}
            className="rounded-lg border border-stone-300 px-3 py-2 text-xs font-semibold disabled:opacity-40"
            onClick={()=>{setNotes(old=>{const next={...old};for(const k of selected)if(!(next[k]??"").trim())next[k]=bulkNote.trim();return next;});clearPreview();}}>
            Apply to selected without a note</button>
        </div>
      </div>
      <div className="mt-4 max-h-[32rem] space-y-3 overflow-y-auto pr-1">
        {visible.map(c=><div className="rounded-xl border border-stone-200 p-4" key={key(c)}>
          <div className="flex items-start gap-3">
            <input type="checkbox" className="mt-1 h-4 w-4 accent-red-800" aria-label={"Approve "+c.email}
              checked={selected.has(key(c))} disabled={busy!==null}
              onChange={e=>{const next=new Set(selected);
                if(e.target.checked){if(next.size<100)next.add(key(c));}else next.delete(key(c));
                setSelected(next);clearPreview();}} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap gap-2"><span className="rounded-md bg-stone-100 px-2 py-1 text-xs font-bold">{c.campus}</span>
                <strong className="break-all text-sm">{c.name||"Name missing"} · {c.email}</strong>
                {c.frequencyLimited&&<span className="rounded-md bg-amber-100 px-2 py-1 text-xs font-bold text-amber-900">Recently contacted</span>}</div>
              <label className="mt-3 block text-xs font-semibold" htmlFor={"evidence-"+key(c)}>Historical correspondence reviewed (required)</label>
              <textarea id={"evidence-"+key(c)} rows={2} maxLength={250}
                value={notes[key(c)]??""} disabled={busy!==null}
                onChange={e=>{setNotes(old=>({...old,[key(c)]:e.target.value}));clearPreview();}}
                placeholder="Example: Checked contact@ and legacy Gmail on [date]; no earlier invitation, withdrawal or opt-out found. Record source and date."
                className="mt-1 w-full rounded-lg border border-stone-300 p-3 text-sm" />
              <p className="mt-1 text-xs text-stone-500">Only approve after checking historical contact@ and legacy Gmail correspondence. An earlier invitation does not disqualify someone who still needs an interview; note it here. The review note is evidence, not an automatic email lookup.</p>
              <label className="mt-2 flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5 accent-red-800"
                checked={exceptions.has(key(c))} disabled={busy!==null}
                onChange={e=>{const next=new Set(exceptions);
                  if(e.target.checked)next.add(key(c));else next.delete(key(c));
                  setExceptions(next);clearPreview();}} />
                <span>Founder exception: invite despite the follow-up frequency limits. Opt-outs, withdrawals, bookings, completed interviews and duplicate sends stay blocked.</span></label>
            </div>
          </div>
        </div>)}
      </div>
      <div className="mt-6 rounded-xl border border-stone-200 bg-stone-50 p-4">
        <label className="block text-sm font-semibold" htmlFor="campaign-run">Choose manual send or scheduled campaign</label>
        <select id="campaign-run" value={runKey} onChange={e=>{setRunKey(e.target.value);clearPreview();}}
          className="mt-2 w-full max-w-md rounded-lg border border-stone-300 bg-white p-3 text-sm">
          {choices.length?choices.map(c=><option key={c.runKey} value={c.runKey}>{c.label}</option>):
            <option value="">No campaigns eligible for approval today</option>}
        </select>
        <p className="mt-2 text-xs text-stone-600">Manual campaigns may be approved and sent today after a second explicit Send action. Scheduled campaigns retain their original times. All batches expire after 24 hours; slots are enforced at booking time, not invitation time.</p>
        <button type="button" onClick={()=>void previewBatch()} disabled={busy!==null||!runKey||!approvedCandidates.length||!!missingNotes.length}
          className="mt-4 rounded-lg bg-[#a91e28] px-4 py-2 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-40">
          {busy==="preview"?"Checking batch…":"Review exact batch"}
        </button>
        {preview&&<div className="mt-4 rounded-xl border border-stone-300 bg-white p-4">
          <h4 className="font-bold">Confirm exact-recipient batch</h4>
          <p className="mt-2 text-sm">{preview.count} total applicants · {preview.bu} BU · {preview.bc} BC. Approval does not send.</p>
          <p className="mt-2 break-all font-mono text-xs text-stone-500">Approval fingerprint: {preview.digest.slice(0,18)}…</p>
          <label className="mt-4 flex items-start gap-2 text-sm"><input className="mt-1 accent-red-800" type="checkbox" checked={confirm} onChange={e=>setConfirm(e.target.checked)} />
            <span>I reviewed the historical correspondence notes for every selected applicant and authorize only this exact batch to be stored.</span></label>
          <button type="button" disabled={!confirm||busy!==null} onClick={()=>void approve()}
            className="mt-4 rounded-lg bg-stone-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
            {busy==="approve"?"Saving…":"Approve and save batch (no sending)"}
          </button>
        </div>}
      </div>
    </>}
    {scanned!==null&&<details className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
      <summary className="cursor-pointer text-sm font-semibold">Held or excluded applicants ({held.length})</summary>
      <p className="mt-2 text-xs text-stone-700">These records cannot be selected for this batch. Keep opt-outs and withdrawals blocked. Correct the source record only if its status or data is wrong, then refresh.</p>
      {held.length?<div className="mt-3 max-h-80 overflow-auto"><table className="w-full min-w-[520px] text-left text-xs"><thead><tr className="border-b border-amber-300 text-stone-600"><th className="p-2">Campus</th><th className="p-2">Applicant</th><th className="p-2">Email</th><th className="p-2">Reason</th></tr></thead>
        <tbody>{held.map(person=><tr className="border-b border-amber-200" key={person.campus+":"+person.pageId}>
          <td className="p-2">{person.campus}</td><td className="p-2">{person.name||"Name missing"}</td>
          <td className="p-2">{person.email||"Email missing"}</td><td className="p-2">{person.decision.replaceAll("_"," ")}</td>
        </tr>)}</tbody></table></div>:<p className="mt-3 text-sm text-stone-600">No additional applicants are held from this batch.</p>}
    </details>}
    {error&&<p className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900" role="alert">{error}</p>}
    {success&&<p className="mt-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-900" role="status">{success}</p>}
    <div className="mt-7 border-t border-stone-200 pt-5">
      <h3 className="text-lg font-bold">Campaign monitoring</h3>
      <p className="mt-1 text-xs text-stone-600">Gmail API acceptance means the message was accepted for sending, not necessarily delivered to an inbox.</p>
      <p className="mt-1 text-xs text-stone-600">Reconcile counts remain held unless the system can verify that Gmail was never contacted.</p>
      {status.length?<div className="mt-4 overflow-x-auto"><table className="w-full min-w-[680px] text-left text-sm"><thead><tr className="border-b text-xs uppercase text-stone-500">
        <th className="p-2">Campaign</th><th className="p-2">State</th><th className="p-2">Approved</th>
        <th className="p-2">Pending</th><th className="p-2">Sent</th><th className="p-2">Suppressed</th><th className="p-2">Reconcile</th><th className="p-2">Action</th></tr></thead>
        <tbody>{status.map(row=><tr key={row.runKey} className="border-b">
          <td className="p-2 font-semibold">{row.runKey}</td><td className="p-2">{row.state}</td>
          <td className="p-2">{row.expectedCount}</td><td className="p-2">{row.pending}</td>
          <td className="p-2">{row.sent}</td><td className="p-2">{row.suppressed}</td>
          <td className="p-2">{row.reconciliation}</td>
          <td className="p-2">
            {row.runKey.startsWith("applicant_manual:")&&["approved","running"].includes(row.state)&&<button type="button"
              className="mb-2 rounded bg-[#a91e28] px-3 py-2 text-xs font-bold text-white disabled:opacity-40"
              disabled={!!busy} onClick={()=>void sendApprovedNow(row.runKey)}>
              {busy==="send"?"Sending…":"Send approved invitations now"}</button>}
            {row.state==="approved"&&row.pending===row.expectedCount&&
              (cancelTarget===row.runKey
              ? <span className="flex flex-col gap-2">
                  <span className="text-xs">Cancel this untouched batch?</span>
                  <button type="button" className="rounded bg-red-800 px-2 py-1 text-xs text-white disabled:opacity-40"
                    disabled={!!busy} onClick={()=>void cancelBatch(row.runKey)}>Confirm cancellation</button>
                  <button type="button" className="text-xs underline" onClick={()=>setCancelTarget(null)}>Keep batch</button>
                </span>
              : <button type="button" className="text-xs font-semibold text-red-800 underline"
                  onClick={()=>setCancelTarget(row.runKey)}>Cancel unsent batch</button>)}
          </td></tr>)}</tbody></table></div>:
        <p className="mt-3 text-sm text-stone-500">No campaigns returned. This is expected until the migration and approval service are enabled.</p>}
      {reconcileRecipients.length>0&&<div className="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-4">
        <h4 className="font-bold">Held invitations that need your review ({reconcileRecipients.length})</h4>
        <p className="mt-1 text-xs text-stone-700">These names and reasons come from the campaign ledger and live BU/BC pipeline. Open the exact Sent search below. If the invitation is there, enter its Gmail message ID and confirm. This records the message as sent; it does not send anything. If there is no matching message, leave the record held. Do not retry an uncertain send.</p>
        <div className="mt-3 space-y-3">{reconcileRecipients.map(person=>{
          const id=reconcileKey(person),query=`in:sent to:${person.email} subject:"Schedule your Campus2Care volunteer interview"`;
          return <div key={id} className="rounded-lg border border-amber-200 bg-white p-3">
            <div className="flex flex-wrap items-center gap-2"><span className="rounded bg-stone-100 px-2 py-1 text-xs font-bold">{person.campus}</span>
              <strong className="text-sm">{person.name} · {person.email}</strong></div>
            <p className="mt-1 text-xs text-stone-600">Held because: {person.errorCode.replaceAll("_"," ")}</p>
            <a className="mt-2 inline-block text-sm font-semibold text-red-800 underline" target="_blank" rel="noreferrer"
              href={`https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`}>Open exact search in Gmail Sent</a>
            <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <label className="text-xs font-semibold">Gmail message ID from the matching sent invitation
                <input value={gmailMessageIds[id]??""} maxLength={200} onChange={event=>setGmailMessageIds(old=>({...old,[id]:event.target.value}))}
                  placeholder="Paste the message ID only after confirming recipient and subject"
                  className="mt-1 block w-full rounded-lg border border-stone-300 p-2 text-sm" />
              </label>
              <button type="button" disabled={busy!==null||!gmailConfirmations.has(id)||!/^[A-Za-z0-9_-]{5,200}$/.test(gmailMessageIds[id]??"")}
                onClick={()=>void recordVerifiedAcceptance(person)}
                className="self-end rounded-lg bg-stone-900 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">
                {busy==="reconcile"?"Recording…":"Record as sent"}</button>
            </div>
            <label className="mt-2 flex items-start gap-2 text-xs text-stone-700">
              <input type="checkbox" checked={gmailConfirmations.has(id)} onChange={event=>setGmailConfirmations(old=>{
                const next=new Set(old);if(event.target.checked)next.add(id);else next.delete(id);return next;
              })} />
              I verified in contact@ Sent that this exact recipient received the Campus2Care interview invitation.
            </label>
          </div>;
        })}</div>
      </div>}
    </div>
  </section>;
}
