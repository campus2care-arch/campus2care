"use client";
import {easternLocalToInstant,instantToEasternLocal} from "../../lib/interview-timezone";
import {useEffect,useState} from "react";
type Team={id:string;revision:string;approvedBy:string|null;campus:string;leadId:string;startsAt:string;participants:{email?:string;name:string;role:string;available:boolean}[]};
const eastern=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",weekday:"short",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
export default function InterviewTeamSchedule({week}:{week:string}) {
 const [canManage,setCanManage]=useState(false),[edit,setEdit]=useState<Team|null>(null),[start,setStart]=useState(""),[lead,setLead]=useState(""),[shadows,setShadows]=useState(""),[notice,setNotice]=useState(""),[saving,setSaving]=useState(false),[reload,setReload]=useState(0);
 const [teams,setTeams]=useState<Team[]|null>(null),[error,setError]=useState("");
 useEffect(()=>{let active=true;void fetch("/api/interview/staff/teams?week="+encodeURIComponent(week),{cache:"no-store"}).then(async response=>{
  const data=await response.json();if(!response.ok||!data.ok)throw Error("Team schedule could not be loaded.");
  if(active){setTeams(data.teams);setCanManage(data.canManage===true);setError("");}
 }).catch(()=>{if(active)setError("Team schedule could not be loaded.");});return()=>{active=false;};},[week,reload]);
 async function checkCalendars(){setSaving(true);setNotice("");try{const response=await fetch("/api/interview/admin/founder-schedule-check",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});const data=await response.json();if(!response.ok||!data.ok)throw Error();setNotice(`${data.slots} slots checked across ${data.participants} participant calendars. ${data.conflictingSlots.length} slots have a calendar conflict. Checked ${new Date(data.checkedAt).toLocaleString()}.`);}catch{setNotice("Calendar check failed. Availability is not verified until every required calendar can be read.");}finally{setSaving(false);}}
 async function saveShift(){if(!edit)return;setSaving(true);setNotice("");try{
  const [date,clock]=start.split("T"),[hour,minute]=clock.split(":").map(Number);
  const response=await fetch("/api/interview/admin/founder-shift",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({slotId:edit.id,revision:edit.revision,startsAt:easternLocalToInstant(date,hour*60+minute).toISOString(),leadEmail:lead,shadowEmails:shadows.split(",").map(e=>e.trim()).filter(Boolean)})});
  const data=await response.json();if(!response.ok||!data.ok)throw Error(data.error??"shift_update_failed");setNotice("Unbooked shift updated. Existing appointments were preserved.");setEdit(null);setReload(v=>v+1);
 }catch(error){setNotice(error instanceof Error&&error.message==="booked_shift_preserved"?"This shift is booked. Its time and participants were preserved.":"Shift could not be updated: "+(error instanceof Error?error.message:"unknown error"));}finally{setSaving(false);}}
 return <section className="my-6 rounded-2xl border border-stone-200 bg-white p-5" aria-label="Assigned interview teams">
  <h2 className="text-xl font-bold">Assigned interview teams</h2>
  <p className="mt-2 text-sm text-stone-600">{week==="2026-11-02"?"November 2–8: exact sheet times, 20-minute interviews, no gaps. ":""}Each row is one interview. Shadowers attend the lead’s meeting.</p>
  {canManage&&week==="2026-11-02"&&<button type="button" disabled={saving} className="button button-secondary mt-3" onClick={()=>void checkCalendars()}>Check every participant calendar</button>}
  {notice&&<p role="status" className="mt-3 rounded-lg bg-stone-100 p-3">{notice}</p>}
  {edit&&canManage&&<form className="my-4 grid gap-3 rounded-xl border border-blue-200 p-4" onSubmit={e=>{e.preventDefault();void saveShift();}}>
   <h3 className="font-bold">Correct an unbooked founder-approved shift</h3>
   <label>Start in Eastern Time<input required type="datetime-local" value={start} onChange={e=>setStart(e.target.value)} className="block rounded border p-2" /></label>
   <label>Lead Workspace email<input required type="email" value={lead} onChange={e=>setLead(e.target.value)} className="block w-full rounded border p-2" /></label>
   <label>Shadower emails, separated by commas<input value={shadows} onChange={e=>setShadows(e.target.value)} className="block w-full rounded border p-2" /></label>
   <div className="flex gap-3"><button disabled={saving} type="submit" className="button button-primary">Save unbooked shift</button><button type="button" onClick={()=>setEdit(null)} className="button button-secondary">Close editor</button></div>
  </form>}
  {error?<p role="alert" className="mt-3 text-red-800">{error}</p>:teams===null?<p className="mt-3">Loading assigned times…</p>:<>
   <p className="mt-3 font-semibold">{teams.length} assigned slots · BU {teams.filter(t=>t.campus==="BU").length} · BC {teams.filter(t=>t.campus==="BC").length}</p>
   <ul className="mt-3 max-h-96 overflow-y-auto divide-y divide-stone-100">{teams.map(team=><li className="py-3 text-sm" key={team.id}>
    <strong>{team.campus} · {eastern.format(new Date(team.startsAt))} ET</strong>
    <p>{team.participants.filter(p=>p.role==="lead").map(p=>p.name).join(", ")}{team.participants.some(p=>p.role==="shadow")?" · Shadowing: "+team.participants.filter(p=>p.role==="shadow").map(p=>p.name).join(", "):""}</p>
    {canManage&&team.approvedBy==="president@campus2care.org"&&<button type="button" className="mt-2 underline" aria-label={"Edit shift "+team.campus+" "+eastern.format(new Date(team.startsAt))} onClick={()=>{const local=instantToEasternLocal(new Date(team.startsAt));setStart(local.date+"T"+String(Math.floor(local.minute/60)).padStart(2,"0")+":"+String(local.minute%60).padStart(2,"0"));setLead(team.participants.find(p=>p.role==="lead")?.email??"");setShadows(team.participants.filter(p=>p.role==="shadow").map(p=>p.email).join(", "));setEdit(team);setNotice("");}}>Edit unbooked shift</button>}
    {team.participants.some(p=>!p.available)&&<p className="text-amber-800">Paused: a participant has withdrawn or revised availability.</p>}
   </li>)}</ul>
  </>}
 </section>;
}
