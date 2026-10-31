"use client";

import { useCallback, useEffect, useState } from "react";

type CanResult = {
  campus: "BU"; state: string; testRecipient: string;
  appointmentStart: string; calendarEventCreated: boolean;
  notionSynchronized: boolean; emailAttempted: boolean;
  gmailAccepted: boolean; meetUrl: string | null;
};
export default function ProviderBookingCanary({ enabled }: { enabled: boolean }) {
  const [data,setData]=useState<CanResult|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const refresh=useCallback(async()=>{
    try {
      const response=await fetch("/api/interview/admin/booking-provider-canary",{cache:"no-store"});
      const payload=await response.json() as {ok?:boolean;result?:CanResult;error?:string};
      if(!response.ok || !payload.result)throw Error(payload.error??"status_unavailable");
      setData(payload.result);setError("");
    }catch(e){setError(e instanceof Error?e.message:"status_unavailable");}
  },[]);
  useEffect(()=>{
    if(!enabled)return;
    const controller=new AbortController();
    void fetch("/api/interview/admin/booking-provider-canary",{
      cache:"no-store",signal:controller.signal,
    }).then(async response=>{
      const payload=await response.json() as {ok?:boolean;result?:CanResult;error?:string};
      if(!response.ok || !payload.result)throw Error(payload.error??"status_unavailable");
      if(!controller.signal.aborted){setData(payload.result);setError("");}
    }).catch(e=>{
      if(!controller.signal.aborted)setError(e instanceof Error?e.message:"status_unavailable");
    });
    return ()=>controller.abort();
  },[enabled]);
  if(!enabled)return null;
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
