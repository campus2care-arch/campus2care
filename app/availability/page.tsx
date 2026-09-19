"use client";

import { useMemo, useState } from "react";

const DAYS = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"] as const;
const START_MINUTES = 8 * 60;
const END_MINUTES = 24 * 60;
const STEP = 30;

function label(mins: number) {
  if (mins === 24 * 60) return "12:00 AM";
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const suffix = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

export default function AvailabilityPage() {
  const slots = useMemo(
    () => Array.from({ length: (END_MINUTES - START_MINUTES) / STEP }, (_, i) => START_MINUTES + i * STEP),
    []
  );
  const [selected, setSelected] = useState<Record<string, Set<number>>>(() =>
    Object.fromEntries(DAYS.map((d) => [d, new Set<number>()]))
  );
  const [dragValue, setDragValue] = useState<boolean | null>(null);
  const [status, setStatus] = useState("");
  const [form, setForm] = useState({ name: "", email: "", cohort: "Unassigned", notes: "" });

  function setSlot(day: string, minute: number, value: boolean) {
    setSelected((prev) => {
      const next = { ...prev, [day]: new Set(prev[day]) };
      value ? next[day].add(minute) : next[day].delete(minute);
      return next;
    });
  }

  function onDown(day: string, minute: number) {
    const value = !selected[day].has(minute);
    setDragValue(value);
    setSlot(day, minute, value);
  }

  function onEnter(day: string, minute: number) {
    if (dragValue !== null) setSlot(day, minute, dragValue);
  }

  function normalizeWindows() {
    const windows: { day: string; start: string; end: string }[] = [];
    for (const day of DAYS) {
      const sorted = [...selected[day]].sort((a, b) => a - b);
      if (!sorted.length) continue;
      let start = sorted[0];
      let last = sorted[0];
      for (let i = 1; i <= sorted.length; i++) {
        const current = sorted[i];
        if (current === last + STEP) {
          last = current;
          continue;
        }
        windows.push({
          day,
          start: `${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`,
          end: `${String(Math.floor((last + STEP) / 60)).padStart(2, "0")}:${String((last + STEP) % 60).padStart(2, "0")}`,
        });
        start = current;
        last = current;
      }
    }
    return windows;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const windows = normalizeWindows();
    if (!form.name || !form.email || !windows.length) {
      setStatus("Add your name, email, and at least one availability block.");
      return;
    }
    setStatus("Saving...");
    const res = await fetch("/api/availability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, windows }),
    });
    const data = await res.json().catch(() => ({}));
    setStatus(res.ok ? "Availability saved." : data.error || "Could not save availability.");
  }

  return (
    <main
      className="min-h-screen bg-[#f5f5f7] px-4 py-8 text-[#1d1d1f] sm:px-6"
      onMouseUp={() => setDragValue(null)}
      onMouseLeave={() => setDragValue(null)}
    >
      <div className="mx-auto max-w-[1180px]">
        <div className="mb-8 rounded-[28px] border border-black/5 bg-white/90 p-7 shadow-[0_20px_60px_rgba(0,0,0,0.06)] backdrop-blur-xl">
          <div className="text-sm font-semibold tracking-wide text-[#86868b]">Campus2Care</div>
          <h1 className="mt-2 text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">Weekly availability</h1>
          <p className="mt-3 max-w-2xl text-[17px] leading-7 text-[#6e6e73]">
            Select the times you are generally available each week. This is not tied to a specific date.
            Drag across the calendar or tap individual blocks.
          </p>
        </div>

        <form onSubmit={submit} className="space-y-6">
          <section className="grid gap-4 rounded-[28px] border border-black/5 bg-white p-6 shadow-[0_20px_60px_rgba(0,0,0,0.05)] sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-sm font-medium">
              Name
              <input
                className="mt-2 w-full rounded-2xl border border-black/10 bg-[#f5f5f7] px-4 py-3 outline-none focus:ring-2 focus:ring-[#0071e3]/30"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Full name"
              />
            </label>
            <label className="text-sm font-medium">
              Email
              <input
                type="email"
                className="mt-2 w-full rounded-2xl border border-black/10 bg-[#f5f5f7] px-4 py-3 outline-none focus:ring-2 focus:ring-[#0071e3]/30"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="name@bu.edu"
              />
            </label>
            <label className="text-sm font-medium">
              Cohort
              <select
                className="mt-2 w-full rounded-2xl border border-black/10 bg-[#f5f5f7] px-4 py-3 outline-none"
                value={form.cohort}
                onChange={(e) => setForm({ ...form, cohort: e.target.value })}
              >
                <option>Unassigned</option>
                <option>Cohort 5</option>
                <option>Cohort 6</option>
              </select>
            </label>
            <label className="text-sm font-medium">
              Notes
              <input
                className="mt-2 w-full rounded-2xl border border-black/10 bg-[#f5f5f7] px-4 py-3 outline-none focus:ring-2 focus:ring-[#0071e3]/30"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="Optional"
              />
            </label>
          </section>

          <section className="overflow-hidden rounded-[28px] border border-black/5 bg-white shadow-[0_20px_60px_rgba(0,0,0,0.05)]">
            <div className="overflow-x-auto">
              <div className="min-w-[980px] select-none">
                <div className="grid grid-cols-[92px_repeat(7,1fr)] border-b border-black/5 bg-white/95">
                  <div className="p-3" />
                  {DAYS.map((day) => (
                    <div key={day} className="p-3 text-center text-sm font-semibold text-[#3a3a3c]">{day.slice(0,3)}</div>
                  ))}
                </div>

                {slots.map((minute) => (
                  <div key={minute} className="grid grid-cols-[92px_repeat(7,1fr)]">
                    <div className="border-r border-black/5 px-3 py-1 text-right text-[11px] text-[#8e8e93]">
                      {minute % 60 === 0 ? label(minute) : ""}
                    </div>
                    {DAYS.map((day) => {
                      const active = selected[day].has(minute);
                      return (
                        <button
                          key={day}
                          type="button"
                          aria-label={`${day} ${label(minute)}`}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            onDown(day, minute);
                          }}
                          onMouseEnter={() => onEnter(day, minute)}
                          onClick={() => setSlot(day, minute, !selected[day].has(minute))}
                          className={[
                            "h-[26px] border-r border-t border-black/[0.045] transition",
                            active ? "bg-[#0071e3] shadow-[inset_0_0_0_1px_rgba(255,255,255,.25)]" : "bg-white hover:bg-[#eef6ff]",
                          ].join(" ")}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="flex flex-col items-start justify-between gap-4 rounded-[28px] border border-black/5 bg-white p-6 shadow-[0_20px_60px_rgba(0,0,0,0.05)] sm:flex-row sm:items-center">
            <div>
              <div className="font-medium">8:00 AM to midnight</div>
              <div className="mt-1 text-sm text-[#86868b]">30-minute blocks. You can select multiple windows on the same day.</div>
              {status && <div className="mt-2 text-sm font-medium">{status}</div>}
            </div>
            <button
              type="submit"
              className="rounded-full bg-[#0071e3] px-7 py-3 font-semibold text-white shadow-sm transition hover:bg-[#0077ed] active:scale-[0.98]"
            >
              Save availability
            </button>
          </section>
        </form>
      </div>
    </main>
  );
}
