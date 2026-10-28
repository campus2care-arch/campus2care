"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import logo from "../../public/images/C2C-logo.png";

type Slot = { interviewerId: string; startsAt: string; endsAt: string; timeZone: string };
type Booking = { id: string; status: string; startsAt: string; endsAt: string; meetUrl?: string|null };
type Reschedule = {id:string;state:string;startsAt:string};
type ResponseShape = { ok?: boolean; error?: string; slots?: Slot[]; booking?: Booking;reschedule?:Reschedule|null };

const eastern = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", weekday: "short", month: "short",
  day: "numeric", hour: "numeric", minute: "2-digit",
});

export default function StudentInterviewPage() {
  const [token, setToken] = useState("");
  const initialToken = useRef<string | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(true);
  const [booking, setBooking] = useState<Booking | null>(null);
  const [choosingReplacement,setChoosingReplacement]=useState(false);
  const [reschedule,setReschedule]=useState<Reschedule|null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [verificationCode,setVerificationCode]=useState("");
  const [verificationNotice,setVerificationNotice]=useState("");

  // The invitation secret is removed from browser history immediately. A
  // fragment is preferred in emailed URLs, since it is not sent to the server.
  useEffect(() => {
    if (initialToken.current === null) {
      const params = new URLSearchParams(window.location.search);
      const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      initialToken.current = fragment.get("token") ?? params.get("token") ?? "";
      window.history.replaceState(null, "", "/interview");
    }
    // The ref also survives React Strict Mode's development effect replay,
    // where reading the URL for a second time would otherwise lose the token.
    queueMicrotask(() => {
      setToken(initialToken.current ?? "");
      if (!initialToken.current) setLoading(false);
    });
  }, []);

  const refresh = useCallback(async (value: string) => {
    setLoading(true);
    try {
      const statusResponse=await fetch("/api/interview/booking/status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({invitationToken:value}),cache:"no-store"});
      const status=await statusResponse.json() as ResponseShape;
      if(!statusResponse.ok||!status.ok)throw new Error(status.error??"booking_status_unavailable");
      setReschedule(status.reschedule??null);
      if(status.ok&&status.booking&&!["canceled","failed","expired"].includes(status.booking.status)){
        setBooking(status.booking);setError("");return;
      }
      setBooking(null);
      const response = await fetch("/api/interview/booking/slots", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invitationToken: value }), cache: "no-store",
      });
      const data = await response.json() as ResponseShape;
      if (!response.ok || !data.ok) throw new Error(data.error ?? "slots_unavailable");
      setSlots(data.slots ?? []);setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "slots_unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (token) queueMicrotask(() => { void refresh(token); });
  }, [refresh, token]);

  useEffect(()=>{
    if(!token||(!["calendar_pending","cancel_pending"].includes(booking?.status??"")&&!reschedule?.state))return;
    let attempts=0,polling=false;
    const timer=setInterval(()=>{
      if(polling)return;
      if(attempts++>=30){clearInterval(timer);return;}
      polling=true;
      void refresh(token).finally(()=>{polling=false;});
    },2000);
    return ()=>clearInterval(timer);
  },[token,booking?.status,reschedule?.state,refresh]);

  const chooseReplacement=async()=>{
    setBusy("slots");setError("");
    try{
      const response=await fetch("/api/interview/booking/slots",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({invitationToken:token,reservationId:booking?.id}),cache:"no-store"});
      const data=await response.json() as ResponseShape;if(!response.ok||!data.ok)throw new Error(data.error);
      setSlots(data.slots??[]);setChoosingReplacement(true);
    }catch{setError("slots_unavailable");}finally{setBusy("");}
  };
  const book = async (slot: Slot) => {
    setBusy(slot.startsAt); setError("");
    try {
      const response = await fetch(choosingReplacement?"/api/interview/booking/reschedule":"/api/interview/booking/hold", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invitationToken: token, reservationId:choosingReplacement?booking?.id:undefined, interviewerId: slot.interviewerId,
          startsAt: slot.startsAt,
        }), cache: "no-store",
      });
      const data = await response.json() as ResponseShape;
      if (!response.ok || !data.ok || (!data.booking&&!data.reschedule)) {
        throw new Error(data.error ?? "booking_unavailable");
      }
      if(data.reschedule){setReschedule(data.reschedule);setChoosingReplacement(false);await refresh(token);}else setBooking(data.booking??null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "booking_unavailable");
      await refresh(token);
    } finally {
      setBusy("");
    }
  };

  const verifyEmail=async(action:"request"|"verify")=>{
    setBusy("verify");setVerificationNotice("");
    try{
      const response=await fetch("/api/interview/booking/verify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,invitationToken:token,code:verificationCode})});
      const data=await response.json();if(!response.ok||!data.ok)throw new Error("Verification could not finish. Check the code or request a new one later.");
      if(action==="verify"){setError("");await refresh(token);}else setVerificationNotice("A verification message is queued. In staging it is delivered only to the test account.");
    }catch(err){setVerificationNotice(err instanceof Error?err.message:"Verification failed.");}finally{setBusy("");}
  };

  const cancelHold = async () => {
    if (!booking) return;
    setBusy("cancel"); setError("");
    try {
      const response = await fetch("/api/interview/booking/cancel", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invitationToken: token, reservationId: booking.id }),
        cache: "no-store",
      });
      const data = await response.json() as ResponseShape;
      if (!response.ok || !data.ok) throw new Error(data.error ?? "cancel_unavailable");
      setBooking(null);
      await refresh(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "cancel_unavailable");
    } finally {
      setBusy("");
    }
  };

  // Pool EAs under a single choice at each time, without disclosing their
  // private schedules. Actual allocation is rechecked transactionally.
  const unique = new Map<string, Slot>();
  for (const slot of slots) if (!unique.has(slot.startsAt)) unique.set(slot.startsAt, slot);

  return (
    <main className="min-h-screen bg-[#f7f7f4] px-4 py-8 text-[#20201d] sm:px-8">
      <div className="mx-auto max-w-3xl">
        <header className="mb-8 flex items-center gap-3 border-b border-black/10 pb-6">
          <Link href="/"><Image src={logo} alt="Campus2Care" width={58} height={58} /></Link>
          <div>
            <p className="text-xs font-black uppercase tracking-widest text-[#b3131b]">Campus2Care</p>
            <h1 className="text-xl font-black">Volunteer interview scheduling</h1>
          </div>
        </header>
        <section className="rounded-3xl border border-black/10 bg-white p-6 shadow-sm sm:p-9">
          <p className="text-xs font-black uppercase tracking-widest text-[#b3131b]">Interview appointments</p>
          <h2 className="mt-2 text-3xl font-black">Choose your interview time</h2>
          <p className="mt-3 text-sm leading-relaxed text-stone-600">
            Interviews last 20 minutes and take place on Google Meet.
            All times are displayed in Eastern Time (Boston).
          </p>

          {!token && !booking && <div className="mt-8 rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
            An individual interview invitation link is required to access scheduling.
          </div>}
          {loading && token && <p className="mt-8 text-sm" role="status">Checking available appointments…</p>}

          {error && <div role="alert" className="mt-7 rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm">
            {error === "interview_booking_disabled"
              ? "Interview self-scheduling is not open yet. Please use the instructions in your Campus2Care email."
              : error === "invalid_or_unverified_invitation"
              ? "This invitation is invalid, expired, or still needs email verification."
              : error === "slot_taken" || error === "already_booked" || error === "slot_conflicts_with_calendar"
              ? "That time is no longer available, or an interview is already booked."
              : "We could not complete that request. Please contact the Campus2Care team for assistance."}
          </div>}

          {error==="invalid_or_unverified_invitation"&&token&&<div className="mt-5 space-y-3">
            <button className="rounded-lg border px-4 py-2 text-sm" disabled={!!busy} onClick={()=>void verifyEmail("request")}>Send email verification code</button>
            <label className="block text-sm">Verification code<input className="ml-3 rounded border p-2" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={verificationCode} onChange={(event)=>setVerificationCode(event.target.value)}/></label>
            <button className="rounded-lg border px-4 py-2 text-sm" disabled={!!busy||!/^\d{6}$/.test(verificationCode)} onClick={()=>void verifyEmail("verify")}>Verify email</button>
            {verificationNotice&&<p role="status" className="text-sm">{verificationNotice}</p>}
          </div>}

          {booking ? <div className="mt-8 rounded-xl border border-stone-200 bg-stone-50 p-6" role="status">
            <p className="font-bold">{booking.status==="confirmed"?"Your staging interview is confirmed.":booking.status==="cancel_pending"?"Cancellation is being processed.":"Your requested time is being processed in staging."}</p>
            <p className="mt-2 text-sm text-stone-700">{eastern.format(new Date(booking.startsAt))} ET</p>
            <p className="mt-2 text-xs text-stone-600">
              {booking.status==="confirmed"?"This synthetic appointment has a unique Google Meet link. You can choose a replacement while keeping this appointment until the new time is confirmed.":"Please wait for Calendar processing before treating this as a confirmed appointment."}
            </p>
            {reschedule&&<p className="mt-3 text-sm">Replacement requested: {eastern.format(new Date(reschedule.startsAt))} ET. Your original appointment remains in place until the replacement is confirmed.</p>}
            {booking.status==="confirmed"&&!reschedule&&<button type="button" disabled={!!busy} onClick={()=>void chooseReplacement()} className="mt-4 mr-3 rounded-lg border px-4 py-2 text-sm">Choose replacement time</button>}
            {choosingReplacement&&<button type="button" disabled={!!busy} onClick={()=>setChoosingReplacement(false)} className="mt-4 rounded-lg border px-4 py-2 text-sm">Keep current appointment</button>}
            {booking.meetUrl&&<a className="mt-3 block underline" href={booking.meetUrl} rel="noreferrer" target="_blank">Open Google Meet</a>}
            <button type="button" className="mt-4 mr-3 rounded-lg border px-4 py-2 text-sm" disabled={!!busy} onClick={()=>void refresh(token)}>Refresh appointment status</button>
            <button type="button" disabled={!!busy||booking.status==="cancel_pending"} onClick={() => void cancelHold()}
              className="mt-5 rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold disabled:opacity-50">
              {busy === "cancel" ? "Canceling…" : "Cancel this appointment"}
            </button>
          </div> : null}
          {(!booking||choosingReplacement) && !loading && !error && token && <div className="mt-8">
            {unique.size ? <>
              <h3 className="mb-4 text-lg font-bold">{choosingReplacement?"Choose a replacement time":"Available times"}</h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {[...unique.values()].map((slot) => <button
                  key={slot.startsAt} type="button"
                  disabled={!!busy} onClick={() => void book(slot)}
                  className="rounded-xl border border-stone-200 bg-white p-4 text-left font-semibold hover:border-[#b3131b] hover:bg-red-50 disabled:opacity-50">
                  {eastern.format(new Date(slot.startsAt))} ET
                  {busy === slot.startsAt && <span className="ml-2 text-xs">Reserving…</span>}
                </button>)}
              </div>
            </> : <p className="text-sm text-stone-600">
              No confirmed appointments are currently available for this invitation.
            </p>}
          </div>}
        </section>
      </div>
    </main>
  );
}
