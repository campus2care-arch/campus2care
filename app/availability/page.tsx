"use client";

import { useCallback, useMemo, useRef, useState } from "react";

const DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;
const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const START_MIN = 7 * 60; // 7:00 am
const END_MIN = 22 * 60; // 10:00 pm
const STEP = 30; // minutes
const ROWS = (END_MIN - START_MIN) / STEP; // 30

type Cell = { d: number; r: number };
type Block = { start: number; end: number; slots: number };

function fmt(min: number) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const ap = h >= 12 ? "pm" : "am";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}${m ? ":" + String(m).padStart(2, "0") : ""}${ap}`;
}

function emptyGrid(): boolean[][] {
  return Array.from({ length: 7 }, () => Array<boolean>(ROWS).fill(false));
}

function blocksFor(col: boolean[]): Block[] {
  const out: Block[] = [];
  let run = 0;
  for (let r = 0; r <= ROWS; r++) {
    const on = r < ROWS && col[r];
    if (on) run++;
    else if (run) {
      out.push({
        start: START_MIN + (r - run) * STEP,
        end: START_MIN + r * STEP,
        slots: run,
      });
      run = 0;
    }
  }
  return out;
}

export default function AvailabilityPage() {
  const [grid, setGrid] = useState<boolean[][]>(emptyGrid);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);

  const dragging = useRef(false);
  const dragMode = useRef(true);
  const anchor = useRef<Cell | null>(null);
  const [preview, setPreview] = useState<Cell | null>(null);

  const inPreview = useCallback(
    (d: number, r: number) => {
      const a = anchor.current;
      if (!dragging.current || !a || !preview) return false;
      return (
        d >= Math.min(a.d, preview.d) &&
        d <= Math.max(a.d, preview.d) &&
        r >= Math.min(a.r, preview.r) &&
        r <= Math.max(a.r, preview.r)
      );
    },
    [preview],
  );

  const commit = useCallback((a: Cell, b: Cell, val: boolean) => {
    setGrid((prev) => {
      const next = prev.map((c) => c.slice());
      for (let d = Math.min(a.d, b.d); d <= Math.max(a.d, b.d); d++) {
        for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++) {
          next[d][r] = val;
        }
      }
      return next;
    });
  }, []);

  function cellFromEvent(target: EventTarget | null): Cell | null {
    const el = target as HTMLElement | null;
    if (!el?.dataset?.d) return null;
    return { d: Number(el.dataset.d), r: Number(el.dataset.r) };
  }

  function onPointerDown(e: React.PointerEvent, d: number, r: number) {
    e.preventDefault();
    dragging.current = true;
    dragMode.current = !grid[d][r];
    anchor.current = { d, r };
    setPreview({ d, r });
  }

  function onPointerEnter(d: number, r: number) {
    if (!dragging.current) return;
    setPreview({ d, r });
  }

  function endDrag() {
    if (!dragging.current) return;
    const a = anchor.current;
    const b = preview;
    dragging.current = false;
    anchor.current = null;
    setPreview(null);
    if (a && b) commit(a, b, dragMode.current);
  }

  function onTouchMove(e: React.TouchEvent) {
    if (!dragging.current) return;
    const t = e.touches[0];
    const c = cellFromEvent(document.elementFromPoint(t.clientX, t.clientY));
    if (c) setPreview(c);
  }

  const stats = useMemo(() => {
    const perDay = grid.map((c) => c.filter(Boolean).length);
    const totalHours = (perDay.reduce((a, b) => a + b, 0) * STEP) / 60;
    let longestWeekday = 0;
    for (let d = 0; d < 5; d++) {
      for (const b of blocksFor(grid[d])) {
        longestWeekday = Math.max(longestWeekday, b.slots * STEP);
      }
    }
    return {
      perDayHours: perDay.map((s) => (s * STEP) / 60),
      totalHours,
      longestWeekdayHours: longestWeekday / 60,
      meets: longestWeekday >= 180,
    };
  }, [grid]);

  function preset(days: number[], from: number, to: number) {
    setGrid((prev) => {
      const next = prev.map((c) => c.slice());
      for (const d of days) {
        for (let r = 0; r < ROWS; r++) {
          const m = START_MIN + r * STEP;
          if (m >= from && m < to) next[d][r] = true;
        }
      }
      return next;
    });
  }

  async function submit() {
    setError("");
    if (!name.trim()) return setError("Please enter your full name.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()))
      return setError("Please enter a valid email address.");
    if (stats.totalHours === 0)
      return setError("Please select at least some availability on the grid.");

    const availabilityByDay: Record<string, string> = {};
    DAYS.forEach((day, d) => {
      const bl = blocksFor(grid[d]);
      availabilityByDay[day] = bl.length
        ? bl.map((b) => `${fmt(b.start)}–${fmt(b.end)}`).join(", ")
        : "unavailable";
    });

    setSending(true);
    try {
      const res = await fetch("/api/availability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim().toLowerCase(),
          notes: notes.trim(),
          totalHours: stats.totalHours,
          longestWeekdayBlockHours: stats.longestWeekdayHours,
          meetsWeekdayBlock: stats.meets,
          availabilityByDay,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setDone(true);
      window.scrollTo(0, 0);
    } catch {
      setSending(false);
      setError(
        "Something went wrong. Please try again, or email campus2care@gmail.com.",
      );
    }
  }

  if (done) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-[#f5f5f5] px-6 text-center text-[#1f2937]">
        <img
          src="/images/C2C-logo.png"
          alt="Campus2Care"
          className="mb-5 h-16 w-16 rounded-full bg-white object-cover shadow-sm ring-1 ring-black/5"
        />
        <h1 className="text-3xl font-black text-[#cc0000]">Thank you</h1>
        <p className="mt-3 max-w-sm text-[#4b5563]">
          Your availability has been recorded. We will follow up about your
          partner site placement.
        </p>
      </main>
    );
  }

  return (
    <main
      className="min-h-screen bg-[#f5f5f5] text-[#1f2937]"
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <header className="sticky top-0 z-50 border-b border-white/10 bg-[#cc0000] text-white shadow-md">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-6 py-4">
          <img
            src="/images/C2C-logo.png"
            alt="Campus2Care logo"
            className="h-10 w-10 rounded-full bg-white object-cover"
          />
          <span className="text-xl font-black tracking-tight">Campus2Care</span>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="flex items-center gap-4">
          <img
            src="/images/C2C-logo.png"
            alt=""
            aria-hidden="true"
            className="hidden h-14 w-14 rounded-full bg-white object-cover shadow-sm ring-1 ring-black/5 sm:block"
          />
          <div>
            <h1 className="text-3xl font-black tracking-tight sm:text-4xl">
              Volunteer Availability
            </h1>
            <p className="mt-1 text-[#4b5563]">
              Tell us when you can volunteer this semester.
            </p>
          </div>
        </div>

        <section className="mt-8 rounded-xl border border-[#cc0000] border-l-4 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-bold uppercase tracking-wide text-[#cc0000]">
            Please read before filling this out
          </h2>
          <div className="mt-3 space-y-3 text-[15px] leading-relaxed">
            <p>
              Please provide your availability for all days of the week as
              accurately and thoroughly as possible.
            </p>
            <p>
              Your availability is very important in determining which
              Campus2Care partner site we can place you at. Most of our partner
              sites require volunteers to have at least one consistent 3&ndash;4
              hour block of availability during a weekday.
            </p>
            <p>
              If you do not have at least one 3&ndash;4 hour weekday time block
              available, you may have fewer placement options and less
              flexibility in choosing a partner site.
            </p>
            <p>
              Please include all times you could realistically commit to
              volunteering, even if you have multiple available periods on the
              same day. The more complete your availability is, the better we
              can match you with a site and schedule that works for you.
            </p>
          </div>
        </section>

        <div className="mt-8 grid gap-5 sm:grid-cols-2">
          <div>
            <label htmlFor="name" className="block text-sm font-semibold">
              Full name <span className="text-[#cc0000]">*</span>
            </label>
            <input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              className="mt-1.5 w-full rounded-lg border border-[#d1d5db] bg-white px-3 py-2.5 outline-none focus:border-[#cc0000] focus:ring-2 focus:ring-[#cc0000]/20"
            />
          </div>
          <div>
            <label htmlFor="email" className="block text-sm font-semibold">
              Email <span className="text-[#cc0000]">*</span>
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="you@bu.edu"
              className="mt-1.5 w-full rounded-lg border border-[#d1d5db] bg-white px-3 py-2.5 outline-none focus:border-[#cc0000] focus:ring-2 focus:ring-[#cc0000]/20"
            />
            <p className="mt-1.5 text-xs text-[#6b7280]">
              Use the same email you applied with.
            </p>
          </div>
        </div>

        <h2 className="mt-10 text-lg font-bold">Your weekly availability</h2>
        <p className="mt-1 text-sm text-[#4b5563]">
          Drag across the grid to mark when you are available. Drag over a
          selection again to clear it. Anything left blank counts as
          unavailable.
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => preset([0, 1, 2, 3, 4], 8 * 60, 12 * 60)}
            className="rounded-full border border-[#d1d5db] bg-white px-3.5 py-1.5 text-sm hover:border-[#cc0000] hover:text-[#cc0000]"
          >
            + Weekday mornings
          </button>
          <button
            type="button"
            onClick={() => preset([0, 1, 2, 3, 4], 12 * 60, 17 * 60)}
            className="rounded-full border border-[#d1d5db] bg-white px-3.5 py-1.5 text-sm hover:border-[#cc0000] hover:text-[#cc0000]"
          >
            + Weekday afternoons
          </button>
          <button
            type="button"
            onClick={() => preset([5, 6], 9 * 60, 17 * 60)}
            className="rounded-full border border-[#d1d5db] bg-white px-3.5 py-1.5 text-sm hover:border-[#cc0000] hover:text-[#cc0000]"
          >
            + Weekends
          </button>
          <button
            type="button"
            onClick={() => setGrid(emptyGrid())}
            className="rounded-full border border-[#d1d5db] bg-white px-3.5 py-1.5 text-sm hover:border-[#cc0000] hover:text-[#cc0000]"
          >
            Clear all
          </button>
        </div>

        <div className="mt-4 overflow-x-auto rounded-xl border border-[#e5e7eb] bg-white">
          <table
            className="w-full min-w-[640px] table-fixed border-collapse select-none"
            onTouchMove={onTouchMove}
            onTouchEnd={endDrag}
          >
            <thead>
              <tr>
                <th className="w-20 bg-[#fafafa] px-2 py-2.5" />
                {DAY_SHORT.map((d) => (
                  <th
                    key={d}
                    className="border-b border-[#e5e7eb] bg-[#fafafa] py-2.5 text-xs font-semibold"
                  >
                    {d}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: ROWS }, (_, r) => {
                const min = START_MIN + r * STEP;
                const isHour = min % 60 === 0;
                const endsHour = (min + STEP) % 60 === 0;
                return (
                  <tr key={r}>
                    <td
                      className={`border-r border-[#e5e7eb] pr-2.5 text-right align-top text-[11px] whitespace-nowrap ${
                        isHour ? "font-semibold text-[#1f2937]" : "text-transparent"
                      }`}
                    >
                      {isHour ? fmt(min) : "."}
                    </td>
                    {DAY_SHORT.map((_, d) => {
                      const on = grid[d][r];
                      const prev = inPreview(d, r);
                      const shown = prev ? dragMode.current : on;
                      return (
                        <td
                          key={d}
                          data-d={d}
                          data-r={r}
                          onPointerDown={(e) => onPointerDown(e, d, r)}
                          onPointerEnter={() => onPointerEnter(d, r)}
                          className={`h-[19px] cursor-pointer border-r border-[#f3f4f6] ${
                            endsHour ? "border-b border-b-[#e5e7eb]" : "border-b border-b-[#fafafa]"
                          } ${
                            shown
                              ? prev
                                ? "bg-[#e08585]"
                                : "bg-[#cc0000]"
                              : "bg-white"
                          }`}
                        />
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-6 rounded-xl border border-[#e5e7eb] bg-white p-5">
          <h3 className="text-sm font-bold">Summary</h3>
          <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
            {DAY_SHORT.map((d, i) => (
              <span key={d}>
                <b className="font-semibold">{d}:</b>{" "}
                {stats.perDayHours[i] ? `${stats.perDayHours[i]} hr` : "—"}
              </span>
            ))}
            <span>
              <b className="font-semibold">Total:</b> {stats.totalHours} hr/week
            </span>
          </div>
          <div
            className={`mt-3.5 rounded-lg border px-3.5 py-2.5 text-sm leading-relaxed ${
              stats.totalHours === 0
                ? "border-[#e8cda3] bg-[#fdf1e3] text-[#7a4b10]"
                : stats.meets
                  ? "border-[#bcdcc5] bg-[#e9f5ec] text-[#1f5130]"
                  : "border-[#e8cda3] bg-[#fdf1e3] text-[#7a4b10]"
            }`}
          >
            {stats.totalHours === 0
              ? "No availability selected yet."
              : stats.meets
                ? `Your longest weekday block is ${stats.longestWeekdayHours} hours. That meets the 3–4 hour block most partner sites require.`
                : `Your longest single weekday block is ${
                    stats.longestWeekdayHours
                      ? stats.longestWeekdayHours + " hours"
                      : "none"
                  }. Most partner sites need at least one consistent 3–4 hour weekday block. You can still submit, but you may have fewer placement options.`}
          </div>
        </div>

        <div className="mt-6">
          <label htmlFor="notes" className="block text-sm font-semibold">
            Notes (optional)
          </label>
          <textarea
            id="notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="Recurring conflicts, weeks you are away, transport limits, preferred site, etc."
            className="mt-1.5 w-full rounded-lg border border-[#d1d5db] bg-white px-3 py-2.5 outline-none focus:border-[#cc0000] focus:ring-2 focus:ring-[#cc0000]/20"
          />
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-4 pb-16">
          <button
            type="button"
            onClick={submit}
            disabled={sending}
            className="rounded-lg bg-[#cc0000] px-7 py-3 font-semibold text-white shadow-sm transition hover:bg-[#a30000] disabled:bg-[#c9c9c9]"
          >
            {sending ? "Submitting…" : "Submit availability"}
          </button>
          {error && <span className="text-sm text-[#cc0000]">{error}</span>}
        </div>
      </div>
    </main>
  );
}
