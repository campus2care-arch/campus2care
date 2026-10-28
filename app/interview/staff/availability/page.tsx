"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import logo from "../../../../public/images/C2C-logo.png";
import {
  dateInWeek, mondayForDate, type WeeklyWindows,
  type TimeWindow, type WeeklyConfirmation, type DateOverride,
} from "../../../../lib/interview-availability";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
type Payload = {
  ok?: boolean; email?: string; role?: "admin" | "ea";
  template?: { recurringWindows: WeeklyWindows[] } | null;
  templateRevision?: string | null;
  confirmation?: WeeklyConfirmation | null;
  confirmationRevision?: string | null;
  confirmationSource?: "postgres" | "legacy_blob" | "missing";
  conflictedBookings?: number;
  error?: string;
};
function nextMonday(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const part = (kind: string) => parts.find((x) => x.type === kind)?.value ?? "";
  const monday = mondayForDate(part("year") + "-" + part("month") + "-" + part("day"));
  const value = new Date(monday + "T00:00:00Z");
  value.setUTCDate(value.getUTCDate() + 7);
  return value.toISOString().slice(0, 10);
}
function atDate(week: string, offset: number): string {
  const d = new Date(week + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
function emptyWeek(): TimeWindow[][] { return DAYS.map(() => []); }
function fromRows(rows: WeeklyWindows[]): TimeWindow[][] {
  const result = emptyWeek();
  for (const day of rows) if (day.weekday >= 0 && day.weekday < 7) result[day.weekday] = day.windows.map((w) => ({ ...w }));
  return result;
}
function toRows(days: TimeWindow[][]): WeeklyWindows[] {
  return days.map((windows, weekday) => ({ weekday, windows }));
}
function toClock(minutes: number) {
  return String(Math.floor(minutes / 60)).padStart(2, "0") + ":" +
    String(minutes % 60).padStart(2, "0");
}
function fromClock(value: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : -1;
}
function overridesFor(base: TimeWindow[][], actual: TimeWindow[][], week: string): DateOverride[] {
  return actual.flatMap((windows, day) => JSON.stringify(windows) === JSON.stringify(base[day])
    ? [] : [{ date: dateInWeek(week, day), kind: "replace" as const, windows }]);
}

export default function StaffAvailabilityPage() {
  const [week, setWeek] = useState(nextMonday);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "ea">("ea");
  const [days, setDays] = useState<TimeWindow[][]>(emptyWeek);
  const [baseDays, setBaseDays] = useState<TimeWindow[][]>(emptyWeek);
  const [confirmation, setConfirmation] = useState<WeeklyConfirmation | null>(null);
  const [templateRevision, setTemplateRevision] = useState<string | null>(null);
  const [confirmationRevision, setConfirmationRevision] = useState<string | null>(null);
  const [confirmationSource, setConfirmationSource] = useState<Payload["confirmationSource"]>();
  const [phase, setPhase] = useState<"loading" | "logged-out" | "ready" | "unavailable">("loading");
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void fetch("/api/interview/staff/availability?week=" + encodeURIComponent(week), { cache: "no-store" })
      .then(async (response) => ({ response, data: await response.json() as Payload }))
      .then(({ response, data }) => {
        if (!active) return;
        setError(""); setNotice("");
        if (response.status === 401) {
          if (new URLSearchParams(window.location.search).get("auth") === "failed") {
            setError("Sign-in could not be completed. Use an approved Campus2Care Workspace account or contact your coordinator.");
          }
          setPhase("logged-out"); return;
        }
        if (!response.ok || !data.ok || !data.email) throw new Error(data.error ?? "service_unavailable");
        setEmail(data.email);
        setRole(data.role === "admin" ? "admin" : "ea");
        setTemplateRevision(data.templateRevision ?? null);
        setConfirmationRevision(data.confirmationRevision ?? null);
        setConfirmationSource(data.confirmationSource);
        setConfirmation(data.confirmation ?? null);
        const underlying = data.confirmation?.recurringWindows ?? data.template?.recurringWindows ?? [];
        const base = fromRows(underlying);
        const effective = base.map((items) => items.map((item) => ({ ...item })));
        for (const override of data.confirmation?.overrides ?? []) {
          const day = DAYS.findIndex((_, i) => dateInWeek(week, i) === override.date);
          if (day >= 0) effective[day] = override.kind === "unavailable" ? [] : (override.windows ?? []).map((w) => ({ ...w }));
        }
        setBaseDays(base); setDays(effective); setPhase("ready");
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "service_unavailable");
        setPhase("unavailable");
      });
    return () => { active = false; };
  }, [week, reloadKey]);

  const offeredHours = useMemo(() => days.flat().reduce(
    (total, window) => total + Math.max(0, window.endMinute - window.startMinute), 0,
  ) / 60, [days]);

  function edit(day: number, index: number, key: keyof TimeWindow, value: number) {
    setNotice("");
    setDays((before) => before.map((windows, d) =>
      d === day ? windows.map((window, i) => i === index ? { ...window, [key]: value } : window) : windows,
    ));
  }
  function add(day: number) {
    setNotice("");
    setDays((before) => before.map((windows, d) => d === day
      ? [...windows, { startMinute: 13 * 60, endMinute: 15 * 60 }] : windows));
  }
  function remove(day: number, index: number) {
    setNotice("");
    setDays((before) => before.map((windows, d) => d === day
      ? windows.filter((_, i) => i !== index) : windows));
  }

  async function save(action: "template" | "confirm", status: "confirmed" | "unavailable" = "confirmed") {
    setError(""); setNotice("");
    setSaving(true);
    try {
      const response = await fetch("/api/interview/staff/availability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action, weekStart: week, status,
          revision: action === "template" ? templateRevision : confirmationRevision,
          recurringWindows: action === "template" ? toRows(days) : toRows(baseDays),
          overrides: action === "confirm" ? overridesFor(baseDays, days, week) : [],
        }),
      });
      const data = await response.json() as Payload & { revision?: string };
      if (!response.ok || !data.ok) {
        if (response.status === 409) throw new Error("Someone updated this schedule elsewhere. Reload before saving.");
        throw new Error(data.error === "invalid_availability"
          ? "Check that each time window ends after it starts, uses five-minute times, and does not overlap another window."
          : "Your availability could not be saved. Try again shortly.");
      }
      if (action === "template") {
        setTemplateRevision(data.revision ?? null);
        setBaseDays(days.map((windows) => windows.map((w) => ({ ...w }))));
        setNotice("Recurring template saved. Future unconfirmed weeks will start with these hours.");
      } else {
        setConfirmationRevision(data.revision ?? null);
        setConfirmation(data.confirmation ?? null);
        if (data.confirmationSource) setConfirmationSource(data.confirmationSource);
        const conflictNote = data.conflictedBookings
          ? " " + data.conflictedBookings + " existing booking(s) now conflict with these hours and must be reviewed by leadership."
          : "";
        setNotice((status === "confirmed" ? "Your interview availability is confirmed for this week." : "No interview availability recorded for this week.") + conflictNote);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save.");
    } finally { setSaving(false); }
  }

  const weeks = Array.from({ length: 5 }, (_, i) => atDate(nextMonday(), (i - 1) * 7));
  return (
    <main className="min-h-screen bg-[#f7f7f4] px-4 py-8 text-[#20201d] sm:px-8">
      <div className="mx-auto max-w-5xl">
        <header className="mb-8 flex flex-wrap items-center justify-between gap-4 border-b border-black/10 pb-6">
          <Link href="/" className="flex items-center gap-3">
            <Image src={logo} alt="Campus2Care" width={56} height={56} className="rounded-xl object-contain" />
            <div><div className="text-xs font-bold uppercase tracking-[.16em] text-[#b3131b]">Campus2Care</div>
              <div className="text-lg font-black">Interview Operations</div></div>
          </Link>
          <div className="flex items-center gap-4 text-sm font-medium">
            {role === "admin" && phase === "ready" && <a href="/interview/admin" className="text-[#b3131b] underline">Leadership dashboard</a>}
            {phase === "ready" && <button className="rounded-full border border-black/15 px-4 py-2" onClick={async () => {
              await fetch("/api/interview/auth/logout", { method: "POST" }); window.location.reload();
            }}>Sign out</button>}
          </div>
        </header>
        <div className="mb-8">
          <span className="text-xs font-black uppercase tracking-[.15em] text-[#b3131b]">EA weekly check-in</span>
          <h1 className="mt-2 text-3xl font-black tracking-tight sm:text-5xl">Interview availability</h1>
          <p className="mt-3 max-w-2xl text-base text-stone-600">Set the hours you can conduct 20-minute virtual volunteer interviews. Your recurring template carries forward, but each week requires confirmation.</p>
        </div>

        {phase === "loading" && <div className="rounded-2xl border border-black/10 bg-white p-8">Loading your schedule…</div>}
        {phase === "logged-out" && <div className="rounded-2xl border border-black/10 bg-white p-8">
          <h2 className="text-xl font-bold">Sign in with your Campus2Care Workspace account</h2>
          <p className="mt-2 text-stone-600">Only approved Executive Associates and leadership can access this page.</p>
          {error && <p role="alert" className="mt-3 text-sm text-red-800">{error}</p>}
          <a className="button button-primary mt-5" href="/api/interview/auth/start?returnTo=%2Finterview%2Fstaff%2Favailability">Sign in with Google</a>
        </div>}
        {phase === "unavailable" && <div role="alert" className="rounded-2xl border border-amber-300 bg-amber-50 p-6">
          <h2 className="font-bold">Availability portal is not enabled yet</h2>
          <p className="mt-2 text-sm">Google OAuth and private availability storage must be configured before the system accepts real EA schedules.</p>
          <button onClick={() => { setPhase("loading"); setReloadKey((key) => key + 1); }} className="button button-secondary mt-4">Retry</button>
        </div>}
        {phase === "ready" && <>
          <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-black/10 bg-white p-5">
            <div><p className="text-xs font-bold uppercase tracking-widest text-stone-500">Signed in</p>
              <p className="font-semibold">{email}</p></div>
            <label className="text-sm font-semibold">Select week
              <select disabled={saving} className="ml-3 rounded-xl border border-stone-300 bg-white p-3" value={week} onChange={(e) => { setPhase("loading"); setWeek(e.target.value); }}>
                {weeks.map((date) => <option key={date} value={date}>{date} to {atDate(date, 6)}</option>)}
              </select>
            </label>
          </div>
          {confirmationSource === "legacy_blob" && <div role="status"
            className="mb-5 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
            This week&apos;s earlier confirmation is still in the legacy preview store.
            Review the hours and press “Confirm my hours for this week” again
            to record them in the staging database. Previously entered hours are preserved.
          </div>}
          <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-2xl border border-black/10 bg-white p-5"><p className="text-xs font-bold uppercase text-stone-500">Weekly response</p>
              <p className="mt-2 text-xl font-black capitalize">{confirmation?.status ?? "Not confirmed"}</p></div>
            <div className="rounded-2xl border border-black/10 bg-white p-5"><p className="text-xs font-bold uppercase text-stone-500">Hours entered</p>
              <p className="mt-2 text-xl font-black">{offeredHours.toFixed(1)} hours</p></div>
            <div className="rounded-2xl border border-black/10 bg-white p-5"><p className="text-xs font-bold uppercase text-stone-500">Interview format</p>
              <p className="mt-2 text-xl font-black">20 min · Google Meet</p></div>
          </div>
          <section className="rounded-2xl border border-black/10 bg-white p-5 sm:p-8">
            <div className="mb-6">
              <h2 className="text-xl font-black">Your weekly hours</h2>
              <p className="mt-1 text-sm text-stone-600">All times Eastern. Add multiple windows per day. Leave a day empty if unavailable. Week-specific changes do not alter your normal template unless you choose to save it.</p>
            </div>
            <fieldset disabled={saving} aria-label="Weekly time windows" className="divide-y divide-stone-200">
              {DAYS.map((day, i) => <div key={day} className="grid gap-3 py-4 sm:grid-cols-[150px_1fr]">
                <div className="font-bold">{day}<p className="mt-1 text-xs font-normal text-stone-500">{dateInWeek(week, i)}</p></div>
                <div className="space-y-2">
                  {days[i].map((w, j) => <div key={j} className="flex flex-wrap items-center gap-2">
                    <input aria-label={day + " start time " + (j + 1)} type="time" step="300" value={toClock(w.startMinute)}
                      onChange={(e) => edit(i, j, "startMinute", fromClock(e.target.value))}
                      className="rounded-lg border border-stone-300 px-3 py-2" />
                    <span className="text-sm text-stone-500">to</span>
                    <input aria-label={day + " end time " + (j + 1)} type="time" step="300" value={toClock(w.endMinute)}
                      onChange={(e) => edit(i, j, "endMinute", fromClock(e.target.value))}
                      className="rounded-lg border border-stone-300 px-3 py-2" />
                    <button type="button" className="rounded-lg px-3 py-2 text-sm font-bold text-[#b3131b] hover:bg-red-50"
                      onClick={() => remove(i, j)}>Remove</button>
                  </div>)}
                  <button type="button" onClick={() => add(i)} className="rounded-lg border border-dashed border-stone-300 px-4 py-2 text-sm font-semibold text-stone-600 hover:border-[#b3131b]">
                    + Add time window
                  </button>
                </div>
              </div>)}
            </fieldset>
            {error && <p role="alert" className="mt-5 rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</p>}
            {notice && <p role="status" className="mt-5 rounded-lg bg-green-50 p-3 text-sm text-green-900">{notice}</p>}
            <div className="mt-6 flex flex-wrap gap-3 border-t border-stone-200 pt-6">
              <button disabled={saving} onClick={() => void save("confirm")} className="button button-primary disabled:opacity-50">
                {saving ? "Saving…" : "Confirm my hours for this week"}
              </button>
              <button disabled={saving} onClick={() => void save("confirm", "unavailable")} className="button button-secondary disabled:opacity-50">
                No interviews this week
              </button>
              <button disabled={saving} onClick={() => void save("template")} className="button button-secondary disabled:opacity-50">
                Save as my recurring template
              </button>
            </div>
            <p className="mt-4 text-xs text-stone-500">Changes to already-booked interviews will require a separate reschedule. No student bookings are enabled while this feature is in development.</p>
          </section>
        </>}
      </div>
    </main>
  );
}
