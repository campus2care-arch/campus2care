"use client";
import {useCallback,useEffect,useMemo,useState} from "react";

type Campus="BU"|"BC";
type Candidate={campus:Campus;pageId:string;recipientHmac:string;email:string;manualReconciliationRequired:boolean};
type ReasonCounts=Record<string,number>;
type CampaignStatus={runKey:string;state:string;expectedCount:number;expiresAt:string;approvedAt:string;
  queued:number;sent:number;suppressed:number;reconciliation:number;pending:number};
type StatusBody={ok?:boolean;campaigns?:CampaignStatus[];error?:string};
type ReviewResponse={ok?:boolean;error?:string;candidates?:Candidate[];
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
  const choices: {runKey:string;label:string}[]=[];
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
    campaign_candidate_changed_or_ineligible:"Some records changed or no longer pass the eligibility checks. Refresh the list and review again.",
    campaign_approval_digest_mismatch:"The approved audience or evidence changed. Preview the exact batch again.",
    campaign_run_already_approved:"This campaign already has an approved batch. Refresh campaign status before proceeding.",
    campaign_approval_unavailable:"Approval service unavailable. Do not repeat approval until status has been checked.",
    founder_access_required:"Sign in using president@campus2care.org to review the applicant audience.",
  };
  return labels[code]??code.replaceAll("_"," ");
}
export default function FounderApplicantCampaigns({enabled=false,previewOnly=false}:{
  enabled?:boolean;previewOnly?:boolean;
}){
  const [candidates,setCandidates]=useState<Candidate[]>([]);
  const [reasons,setReasons]=useState<ReasonCounts>({});
  const [scanned,setScanned]=useState<number|null>(null);
  const [selected,setSelected]=useState<Set<string>>(new Set());
  const [notes,setNotes]=useState<Record<string,string>>({});
  const [campus,setCampus]=useState<"ALL"|Campus>("ALL");
  const [search,setSearch]=useState("");
  const choices=useMemo(upcomingCampaigns,[]);
  const [runKey,setRunKey]=useState(choices[0]?.runKey??"");
  const [preview,setPreview]=useState<null|{digest:string;count:number;bu:number;bc:number}>(null);
  const [confirm,setConfirm]=useState(false);
  const [status,setStatus]=useState<CampaignStatus[]>([]);
  const [busy,setBusy]=useState<"refresh"|"preview"|"approve"|"status"|null>(null);
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
      if(response.ok&&body.ok&&Array.isArray(body.campaigns))setStatus(body.campaigns);
    } catch {/* Availability is optional while the database migration is pending. */}
  },[]);
  useEffect(()=>{
    if(enabled&&!previewOnly){void loadStatus();}
  },[enabled,previewOnly,loadStatus]);
  async function refresh(){
    setBusy("refresh");setError("");clearPreview();
    setCandidates([]);setSelected(new Set());
    try{
      const result=await api("candidates");
      setCandidates(result.candidates??[]);
      setReasons(result.countsByDecision??{});
      setScanned(result.scanned??0);
      await loadStatus();
    }catch(e){setError(errorLabel(e instanceof Error?e.message:"audience_review_unavailable"));}
    finally{setBusy(null);}
  }
  const requested=()=>({runKey,recipients:approvedCandidates.map(c=>({
    campus:c.campus,pageId:c.pageId,recipientHmac:c.recipientHmac,
    manualReference:(notes[key(c)]??"").trim()
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
      Real applicant messages are <strong>not activated by this panel</strong>. Your recipient selection and signed approval are separate from the scheduler's production send authorization. Reconcile past Gmail invitations before selecting anyone.
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
          <p className="text-xs text-stone-600">Selected: {approvedCandidates.length} / 50 per campaign · notes missing: {missingNotes.length}</p></div>
        <div className="flex flex-wrap gap-2">
          <select aria-label="Filter by campus" value={campus} onChange={e=>setCampus(e.target.value as "ALL"|Campus)} className="rounded-lg border border-stone-300 px-3 py-2 text-sm">
            <option value="ALL">Both campuses</option><option value="BU">Boston University</option><option value="BC">Boston College</option>
          </select>
          <input aria-label="Filter by applicant email" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search email" className="w-48 rounded-lg border border-stone-300 px-3 py-2 text-sm" />
        </div>
      </div>
      <div className="mt-4 max-h-[32rem] space-y-3 overflow-y-auto pr-1">
        {visible.map(c=><div className="rounded-xl border border-stone-200 p-4" key={key(c)}>
          <div className="flex items-start gap-3">
            <input type="checkbox" className="mt-1 h-4 w-4 accent-red-800" aria-label={"Approve "+c.email}
              checked={selected.has(key(c))} disabled={busy!==null}
              onChange={e=>{const next=new Set(selected);
                if(e.target.checked){if(next.size<50)next.add(key(c));}else next.delete(key(c));
                setSelected(next);clearPreview();}} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap gap-2"><span className="rounded-md bg-stone-100 px-2 py-1 text-xs font-bold">{c.campus}</span>
                <strong className="break-all text-sm">{c.email}</strong></div>
              <label className="mt-3 block text-xs font-semibold" htmlFor={"evidence-"+key(c)}>Historical correspondence reviewed (required)</label>
              <textarea id={"evidence-"+key(c)} rows={2} maxLength={250}
                value={notes[key(c)]??""} disabled={busy!==null}
                onChange={e=>{setNotes(old=>({...old,[key(c)]:e.target.value}));clearPreview();}}
                placeholder="Example: Checked contact@ and legacy Gmail on [date]; no earlier invitation, withdrawal or opt-out found. Record source and date."
                className="mt-1 w-full rounded-lg border border-stone-300 p-3 text-sm" />
              <p className="mt-1 text-xs text-stone-500">Only approve after checking historical contact@ and legacy Gmail correspondence. The review note is evidence, not an automatic email lookup.</p>
            </div>
          </div>
        </div>)}
      </div>
      <div className="mt-6 rounded-xl border border-stone-200 bg-stone-50 p-4">
        <label className="block text-sm font-semibold" htmlFor="campaign-run">Upcoming invitation campaign</label>
        <select id="campaign-run" value={runKey} onChange={e=>{setRunKey(e.target.value);clearPreview();}}
          className="mt-2 w-full max-w-md rounded-lg border border-stone-300 bg-white p-3 text-sm">
          {choices.length?choices.map(c=><option key={c.runKey} value={c.runKey}>{c.label}</option>):
            <option value="">No campaigns eligible for approval today</option>}
        </select>
        <p className="mt-2 text-xs text-stone-600">Campaign approvals are only valid on the scheduled day or day before. They expire after 24 hours.</p>
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
    {error&&<p className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900" role="alert">{error}</p>}
    {success&&<p className="mt-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-900" role="status">{success}</p>}
    <div className="mt-7 border-t border-stone-200 pt-5">
      <h3 className="text-lg font-bold">Campaign monitoring</h3>
      <p className="mt-1 text-xs text-stone-600">Gmail API acceptance means the message was accepted for sending, not necessarily delivered to an inbox.</p>
      {status.length?<div className="mt-4 overflow-x-auto"><table className="w-full min-w-[680px] text-left text-sm"><thead><tr className="border-b text-xs uppercase text-stone-500">
        <th className="p-2">Campaign</th><th className="p-2">State</th><th className="p-2">Approved</th>
        <th className="p-2">Pending</th><th className="p-2">Sent</th><th className="p-2">Suppressed</th><th className="p-2">Reconcile</th></tr></thead>
        <tbody>{status.map(row=><tr key={row.runKey} className="border-b">
          <td className="p-2 font-semibold">{row.runKey}</td><td className="p-2">{row.state}</td>
          <td className="p-2">{row.expectedCount}</td><td className="p-2">{row.pending}</td>
          <td className="p-2">{row.sent}</td><td className="p-2">{row.suppressed}</td>
          <td className="p-2">{row.reconciliation}</td></tr>)}</tbody></table></div>:
        <p className="mt-3 text-sm text-stone-500">No campaigns returned. This is expected until the migration and approval service are enabled.</p>}
    </div>
  </section>;
}
