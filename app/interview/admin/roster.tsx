"use client";
import {useState} from "react";
type Row={id:string;workspace_email:string;display_name:string;active:boolean;allowed_campuses:Array<"BU"|"BC">;weekly_capacity_limit:number};
export default function InterviewRoster(){
  const [rows,setRows]=useState<Row[]>([]),[notice,setNotice]=useState(""),[busy,setBusy]=useState(false);
  const [email,setEmail]=useState(""),[name,setName]=useState(""),[active,setActive]=useState(false),[capacity,setCapacity]=useState(0),[bu,setBu]=useState(true),[bc,setBc]=useState(false);
  async function load(){
    const response=await fetch("/api/interview/admin/roster",{cache:"no-store"});const data=await response.json();
    if(!response.ok||!data.ok)throw new Error("Could not load interviewers.");setRows(data.roster);
  }
  async function refresh(){setBusy(true);setNotice("");try{await load();}catch{setNotice("Could not load interviewers.");}finally{setBusy(false);}}
  async function save(){
    setBusy(true);setNotice("");
    try{
      const response=await fetch("/api/interview/admin/roster",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email,displayName:name,active,campuses:[...(bu?["BU"]:[]),...(bc?["BC"]:[])],weeklyCapacity:capacity})});
      const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error==="interviewer_not_in_verified_allowlist"?"This address needs verified staff sign-in access before it can be added.":"Could not save. Check the name, campuses, and weekly limit.");
      setNotice(`Saved. ${data.appointmentsRequiringReview} existing appointments need review. Weekly responses and booked appointments were preserved.`);await load();
    }catch(error){setNotice(error instanceof Error?error.message:"Could not save.");}finally{setBusy(false);}
  }
  return <section className="mb-7 rounded-2xl border border-black/10 bg-white p-5">
    <h2 className="text-lg font-black">Interviewer management</h2>
    <p className="mt-2 text-sm text-stone-600">Preview configuration. Only verified staff addresses are accepted. Activation requires an approved campus assignment, a weekly limit, and separately confirmed availability.</p>
    <button className="button button-secondary mt-3" disabled={busy} onClick={()=>void refresh()}>Load interviewers</button>
    <ul className="my-3 space-y-2">{rows.map(row=><li key={row.id}><button className="underline" disabled={busy} onClick={()=>{setEmail(row.workspace_email);setName(row.display_name);setActive(row.active);setCapacity(row.weekly_capacity_limit);setBu(row.allowed_campuses.includes("BU"));setBc(row.allowed_campuses.includes("BC"));}}>{row.display_name} ({row.workspace_email}): {row.active?"active":"inactive"}, {row.allowed_campuses.join(" / ")}, limit {row.weekly_capacity_limit}</button></li>)}</ul>
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={event=>{event.preventDefault();void save();}}>
      <label>Verified Workspace email<input required type="email" className="mt-1 block w-full rounded border p-2" disabled={busy} value={email} onChange={event=>setEmail(event.target.value)}/></label>
      <label>Interviewer name<input required maxLength={100} className="mt-1 block w-full rounded border p-2" disabled={busy} value={name} onChange={event=>setName(event.target.value)}/></label>
      <label>Maximum interviews per week<input required type="number" min={0} max={100} className="mt-1 block w-full rounded border p-2" disabled={busy} value={capacity} onChange={event=>setCapacity(Number(event.target.value))}/></label>
      <fieldset disabled={busy} className="flex flex-wrap items-center gap-4"><legend>Campuses and activation</legend>
        <label><input type="checkbox" checked={bu} onChange={event=>setBu(event.target.checked)}/> BU</label>
        <label><input type="checkbox" checked={bc} onChange={event=>setBc(event.target.checked)}/> BC</label>
        <label><input type="checkbox" checked={active} onChange={event=>setActive(event.target.checked)}/> Active for booking</label>
      </fieldset>
      <button className="button button-secondary" disabled={busy}>Save interviewer settings</button>
    </form>
    {notice&&<p role="status" className="mt-3 text-sm">{notice}</p>}
  </section>;
}
