"use client";
import { useEffect, useMemo, useState } from "react";

type Campus = "BU" | "BC";
type Slot = { id: string; campus: Campus; startsAt: string; date: string; minute: number; lead: string;
  shadowers: string[]; status: "booked" | "open" | "blocked"; reason: string | null };

function mondays(): string[] {
  const today = new Date(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date()) + "T12:00:00Z");
  today.setUTCDate(today.getUTCDate() - (today.getUTCDay() + 6) % 7);
  return [0, 1, 2, 3, 4].map((w) => { const d = new Date(today); d.setUTCDate(d.getUTCDate() + 7 * w); return d.toISOString().slice(0, 10); });
}
const clock = (minute: number) => { const h = Math.floor(minute / 60), m = minute % 60;
  return (h % 12 || 12) + ":" + String(m).padStart(2, "0") + (h < 12 ? " AM" : " PM"); };
const day = (date: string) => new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
const CHIP = { open: "bg-green-100 text-green-900", booked: "bg-blue-100 text-blue-900", blocked: "bg-stone-200 text-stone-700" };

export default function SlotTimetable({ campus }: { campus: Campus | "ALL" }) {
  const weeks = useMemo(() => mondays(), []);
  const [week, setWeek] = useState(weeks[1]);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    fetch(`/api/interview/admin/slots?campus=${campus}&week=${week}`, { cache: "no-store" })
      .then(async (r) => { const b = await r.json(); if (!r.ok || !b.ok) throw new Error(b.error ?? "slots_unavailable"); return b.slots as Slot[]; })
      .then((list) => { if (live) { setSlots(list); setError(""); } })
      .catch((e: unknown) => { if (live) { setSlots(null); setError(e instanceof Error ? e.message.replaceAll("_", " ") : "slots unavailable"); } });
    return () => { live = false; };
  }, [campus, week, reload]);

  async function act(body: object) {
    setBusy(true); setError(""); setNote("");
    try {
      const r = await fetch("/api/interview/admin/slots", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const b = await r.json();
      if (!r.ok || !b.ok) throw new Error(b.error ?? "slot_update_unavailable");
      if ("created" in b) setNote(`Created ${b.created} slot(s), ${b.withShadow} with a shadower. ${b.skipped} already existed or clashed and were skipped.`);
      setReload((n) => n + 1);
    } catch (e) { setError(e instanceof Error ? e.message.replaceAll("_", " ") : "update failed"); }
    finally { setBusy(false); }
  }

  const byDay = new Map<string, Slot[]>();
  for (const s of slots ?? []) byDay.set(s.date, [...(byDay.get(s.date) ?? []), s]);
  const count = (st: Slot["status"]) => (slots ?? []).filter((s) => s.status === st).length;

  return <section className="rounded-2xl border border-black/10 bg-white p-6 shadow-sm">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><p className="text-xs font-black uppercase tracking-widest text-[#b3131b]">Interview slots</p>
        <h2 className="mt-1 text-2xl font-black">20-minute slots {campus === "ALL" ? "(BU and BC)" : "· " + campus}</h2></div>
      <div className="flex flex-wrap gap-2">
        <select aria-label="Week" value={week} onChange={(e) => setWeek(e.target.value)} className="rounded-lg border border-stone-300 px-3 py-2 text-sm">
          {weeks.map((w) => <option key={w} value={w}>Week of {w}</option>)}</select>
        {campus !== "ALL" && <button type="button" disabled={busy} onClick={() => void act({ action: "generate", campus, week })}
          className="rounded-full bg-[#b3131b] px-4 py-2 text-sm font-bold text-white disabled:opacity-40">Generate {campus} slots from submitted availability</button>}
      </div>
    </div>
    <p className="mt-2 text-xs text-stone-500">All times Eastern. BU interviews may be booked with the lead alone; BC interviews need a lead and assigned shadower. Generated slots follow confirmed availability, and existing slots or bookings are never changed. Google Calendar conflicts are checked again when an applicant books.{campus === "ALL" ? " Choose BU or BC to generate slots." : ""}</p>
    {error && <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-900">{error}</p>}
    {note && <p role="status" className="mt-3 rounded-lg bg-green-50 p-3 text-sm text-green-900">{note}</p>}
    <p className="mt-4 text-sm"><span className="font-bold">{count("open")}</span> open · <span className="font-bold">{count("booked")}</span> booked · <span className="font-bold">{count("blocked")}</span> blocked</p>
    <div className="mt-3 space-y-4">
      {[...byDay].map(([date, list]) => <div key={date}>
        <h3 className="font-bold">{day(date)}</h3>
        <ul className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{list.map((s) => <li key={s.id} className="rounded-lg border border-stone-200 p-3 text-sm">
          <div className="flex items-center justify-between gap-2"><strong>{clock(s.minute)}–{clock(s.minute + 20)}</strong>
            <span className={"rounded px-2 py-0.5 text-xs font-bold " + CHIP[s.status]}>{s.campus} · {s.status}</span></div>
          <p className="mt-1">Lead: {s.lead}</p>
          <p className="text-stone-600">Shadower: {s.shadowers.length ? s.shadowers.join(", ") : "none"}</p>
          {s.reason && <p className="text-xs text-stone-500">{s.reason}</p>}
          {s.status !== "booked" && <button type="button" disabled={busy} className="mt-1 text-xs text-red-800 underline"
            onClick={() => { if (window.confirm("Remove this slot?")) void act({ action: "remove", slotId: s.id }); }}>Remove slot</button>}
        </li>)}</ul>
      </div>)}
      {slots && !slots.length && <p className="text-sm text-stone-500">No slots this week yet. Once interviewers submit availability, use Generate.</p>}
    </div>
  </section>;
}
