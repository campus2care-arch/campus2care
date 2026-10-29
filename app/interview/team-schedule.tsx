"use client";
import {useEffect,useState} from "react";
type Team={campus:string;leadId:string;startsAt:string;participants:{name:string;role:string;available:boolean}[]};
const eastern=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",weekday:"short",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
export default function InterviewTeamSchedule({week}:{week:string}) {
 const [teams,setTeams]=useState<Team[]|null>(null),[error,setError]=useState("");
 useEffect(()=>{let active=true;void fetch("/api/interview/staff/teams?week="+encodeURIComponent(week),{cache:"no-store"}).then(async response=>{
  const data=await response.json();if(!response.ok||!data.ok)throw Error("Team schedule could not be loaded.");
  if(active){setTeams(data.teams);setError("");}
 }).catch(()=>{if(active)setError("Team schedule could not be loaded.");});return()=>{active=false;};},[week]);
 return <section className="my-6 rounded-2xl border border-stone-200 bg-white p-5" aria-label="Assigned interview teams">
  <h2 className="text-xl font-bold">Assigned interview teams</h2>
  <p className="mt-2 text-sm text-stone-600">{week==="2026-11-02"?"November 2–8: exact sheet times, 20-minute interviews, no gaps. ":""}Each row is one interview. Shadowers attend the lead’s meeting.</p>
  {error?<p role="alert" className="mt-3 text-red-800">{error}</p>:teams===null?<p className="mt-3">Loading assigned times…</p>:<>
   <p className="mt-3 font-semibold">{teams.length} assigned slots · BU {teams.filter(t=>t.campus==="BU").length} · BC {teams.filter(t=>t.campus==="BC").length}</p>
   <ul className="mt-3 max-h-96 overflow-y-auto divide-y divide-stone-100">{teams.map(team=><li className="py-3 text-sm" key={team.leadId+team.startsAt}>
    <strong>{team.campus} · {eastern.format(new Date(team.startsAt))} ET</strong>
    <p>{team.participants.filter(p=>p.role==="lead").map(p=>p.name).join(", ")}{team.participants.some(p=>p.role==="shadow")?" · Shadowing: "+team.participants.filter(p=>p.role==="shadow").map(p=>p.name).join(", "):""}</p>
    {team.participants.some(p=>!p.available)&&<p className="text-amber-800">Paused: a participant has withdrawn or revised availability.</p>}
   </li>)}</ul>
  </>}
 </section>;
}
