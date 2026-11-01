"use client";

import { useCallback, useEffect, useState } from "react";

type CanResult = {
  campus: "BU"; state: string; testRecipient: string;
  appointmentStart: string; calendarEventCreated: boolean;
  notionSynchronized: boolean; emailAttempted: boolean;
  gmailAccepted: boolean; meetUrl: string | null;
};
type LiveResult = {
  mode: "live"; checkedAt: string;
  googleCredential: { connected: boolean; account: string | null; calendarScope: boolean; gmailScope: boolean };
  notionConfigured: boolean;
  openSlots: Record<"BU"|"BC", number>; blockedSlots: Record<"BU"|"BC", number>; bookedSlots: Record<"BU"|"BC", number>;
  outbox: { pending: number; failed: number; reconcileRequired: number; lastDoneAt: string | null };
  testReservations: Array<{ campus: string; status: string; startsAt: string; hasMeet: boolean; hasCalendarEvent: boolean }>;
  problems: string[];
};
function LiveBookingCheck({ data, onRefresh }: { data: LiveResult; onRefresh: () => void }) {
  const [link,setLink]=useState<{campus:string;bookingLink:string;testEmail:string;expiresAt:string}|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  async function issue(campus:"BU"|"BC"){
    setBusy(true);setError("");setLink(null);
    try{
      const response=await fetch("/api/interview/admin/booking-provider-canary",{method:"POST",
        headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"live_test_link",campus}),cache:"no-store"});
      const payload=await response.json() as {result?:{campus:string;bookingLink:string;testEmail:string;expiresAt:string};error?:string};
      if(!response.ok||!payload.result)throw Error(payload.error??"test_link_unavailable");
      setLink(payload.result);
    }catch(e){setError(e instanceof Error?e.message:"test_link_unavailable");}
    finally{setBusy(false);}
  }
  const ok=data.problems.length===0;
  return <section className="mt-8 border-t border-stone-200 pt-6" aria-label="Live booking check">
    <h2 className="text-lg font-bold">Live booking check</h2>
    <p className={"mt-2 text-sm font-semibold "+(ok?"text-green-800":"text-red-800")}>
      {ok?"Booking providers and capacity look ready.":"Needs attention: "+data.problems.map(p=>p.replaceAll("_"," ")).join(", ")}</p>
    <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
      <p><strong>Google:</strong> {data.googleCredential.connected?(data.googleCredential.account??"connected"):"not connected"}
        {data.googleCredential.connected&&<> · Calendar {data.googleCredential.calendarScope?"✓":"✗"} · Gmail {data.googleCredential.gmailScope?"✓":"✗"}</>}</p>
      <p><strong>Notion:</strong> {data.notionConfigured?"configured":"not configured"}</p>
      <p><strong>Open slots (this + next week):</strong> BU {data.openSlots.BU} · BC {data.openSlots.BC}</p>
      <p><strong>Booked / blocked:</strong> BU {data.bookedSlots.BU}/{data.blockedSlots.BU} · BC {data.bookedSlots.BC}/{data.blockedSlots.BC}</p>
      <p><strong>Delivery queue:</strong> {data.outbox.pending} pending · {data.outbox.failed} failed · {data.outbox.reconcileRequired} need reconciliation</p>
      <p><strong>Checked:</strong> {new Date(data.checkedAt).toLocaleString("en-US",{timeZone:"America/New_York"})} ET</p>
    </div>
    {data.testReservations.length>0&&<div className="mt-3 text-sm"><strong>System-test bookings:</strong>
      <ul className="ml-5 list-disc">{data.testReservations.map((r,i)=><li key={i}>{r.campus} · {r.status} · {new Date(r.startsAt).toLocaleString("en-US",{timeZone:"America/New_York"})} ET · Calendar {r.hasCalendarEvent?"✓":"✗"} · Meet {r.hasMeet?"✓":"✗"}</li>)}</ul></div>}
    <p className="mt-4 text-sm text-stone-600">Controlled test: issue a one-time booking link for the internal system-test applicant (never a real volunteer). Opening it uses the real booking flow; the verification code and confirmation go to the contact@ test alias. The interview team on the chosen slot receives the calendar invite and its cancellation, so cancel the test right after checking it.</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" disabled={busy} onClick={()=>void issue("BU")} className="rounded-lg bg-red-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">BU test booking link</button>
      <button type="button" disabled={busy} onClick={()=>void issue("BC")} className="rounded-lg bg-red-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">BC test booking link</button>
      <button type="button" disabled={busy} onClick={onRefresh} className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold">Refresh</button>
    </div>
    {link&&<p className="mt-3 break-all text-sm">{link.campus} link for {link.testEmail} (expires {new Date(link.expiresAt).toLocaleString("en-US",{timeZone:"America/New_York"})} ET): <a className="underline" href={link.bookingLink} target="_blank" rel="noreferrer">open test booking</a></p>}
    {error&&<p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
  </section>;
}

export default function ProviderBookingCanary({ enabled }: { enabled: boolean }) {
  const [data,setData]=useState<CanResult|null>(null);
  const [live,setLive]=useState<LiveResult|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const refresh=useCallback(async()=>{
    try {
      const response=await fetch("/api/interview/admin/booking-provider-canary",{cache:"no-store"});
      const payload=await response.json() as {ok?:boolean;result?:CanResult|LiveResult;error?:string};
      if(!response.ok || !payload.result)throw Error(payload.error??"status_unavailable");
      if("mode" in payload.result)setLive(payload.result);else setData(payload.result);setError("");
    }catch(e){setError(e instanceof Error?e.message:"status_unavailable");}
  },[]);
  useEffect(()=>{
    if(!enabled)return;
    const controller=new AbortController();
    void fetch("/api/interview/admin/booking-provider-canary",{
      cache:"no-store",signal:controller.signal,
    }).then(async response=>{
      const payload=await response.json() as {ok?:boolean;result?:CanResult|LiveResult;error?:string};
      if(!response.ok || !payload.result)throw Error(payload.error??"status_unavailable");
      if(!controller.signal.aborted){
        const result=payload.result;
        if("mode" in result)setLive(result);else setData(result);setError("");
      }
    }).catch(e=>{
      if(!controller.signal.aborted)setError(e instanceof Error?e.message:"status_unavailable");
    });
    return ()=>controller.abort();
  },[enabled]);
  if(!enabled)return null;
  if(live)return <LiveBookingCheck data={live} onRefresh={()=>void refresh()} />;
  const cleaned = data?.state === "cleaned";
  const cancelling = data?.state === "event_canceled" || data?.state === "cleanup_started";
  const isHistoricalEvent = cleaned || cancelling;
  const calendarLabel = cleaned ? "Cancelled (audit record retained)"
    : cancelling ? "Cancellation in progress"
    : data?.calendarEventCreated ? "Event created" : "No event confirmed";
  const notionLabel = cleaned ? "Test record restored"
    : cancelling ? "Cleanup in progress"
    : data?.notionSynchronized ? "Test record synchronized" : "Not yet synchronized";
  async function operate(action:"create"|"cleanup"){
    setBusy(true);setError("");
    try{
      const response=await fetch("/api/interview/admin/booking-provider-canary",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({action}),cache:"no-store",
      });
      const payload=await response.json() as {ok?:boolean;result?:CanResult;error?:string};
      if(!response.ok || !payload.result)throw Error(payload.error??"outcome_unknown");
      setData(payload.result);
    }catch(e){
      setError((e instanceof Error?e.message:"outcome_unknown")+
        ". Do not retry. Inspect provider and database state.");
      // Status read is safe and can help distinguish accepted provider effects.
      await refresh();
    }finally{setBusy(false);}
  }
  return <section className="mt-8 border-t border-stone-200 pt-6" aria-label="Synthetic production provider booking test">
    <h2 className="text-lg font-bold">Single synthetic booking integration test</h2>
    <p className="mt-2 text-sm text-stone-600">
      BU test applicant only. November 9 at 2:00 PM Eastern, outside the founder-approved
      November 2–8 schedule. No interview staff or volunteers, no approved slots consumed.
      Calendar invitations are suppressed. Exactly one confirmation to the test alias,
      followed by manual cleanup.
    </p>
    <div className="mt-4 rounded-lg border border-stone-200 p-4 text-sm">
      <p><strong>Test recipient:</strong> contact+interview-canary-bu@campus2care.org</p>
      <p className="mt-2"><strong>State:</strong> {data?.state??"checking"}</p>
      <p className="mt-2"><strong>Calendar:</strong> {calendarLabel}</p>
      <p className="mt-1"><strong>Notion:</strong> {notionLabel}</p>
      <p className="mt-1"><strong>Gmail:</strong> {data?.gmailAccepted?"Accepted by Gmail":data?.emailAttempted?"Attempted; manual reconciliation required":"No email sent"}</p>
      {data?.meetUrl && !isHistoricalEvent && <p className="mt-2">Meet URL: <a href={data.meetUrl} target="_blank" rel="noreferrer" className="underline">View generated Meet</a></p>}
      {error && <p role="alert" className="mt-3 text-red-700">{error}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={()=>void refresh()} disabled={busy}
          className="rounded-lg border border-stone-300 px-4 py-2 font-semibold disabled:opacity-40">
          Refresh status
        </button>
        <button type="button" disabled={busy || data?.state!=="not_started"}
          onClick={()=>void operate("create")}
          className="rounded-lg bg-red-800 px-4 py-2 font-semibold text-white disabled:opacity-40">
          Run one test booking
        </button>
        <button type="button" disabled={busy || data?.state!=="complete"}
          onClick={()=>void operate("cleanup")}
          className="rounded-lg border border-stone-300 px-4 py-2 font-semibold disabled:opacity-40">
          Cancel and clean up test booking
        </button>
      </div>
    </div>
  </section>;
}
