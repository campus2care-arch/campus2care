"use client";

import InterviewTeamSchedule from "../../team-schedule";
import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import logo from "../../../../public/images/C2C-logo.png";
import { interviewWeekChoices } from "../../../../lib/interview-week-choice";
import {
  buildInterviewSlots, dateInWeek, type WeeklyWindows,
  type TimeWindow, type WeeklyConfirmation, type InterviewSlot,
} from "../../../../lib/interview-availability";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
type Payload = {
  approvalSource?: "ea" | "founder";
  ok?: boolean; email?: string; role?: "admin" | "ea" | "chapter_admin";
  template?: { recurringWindows: WeeklyWindows[] } | null;
  templateRevision?: string | null;
  confirmation?: WeeklyConfirmation | null;
  confirmationRevision?: string | null;
  confirmationSource?: "postgres" | "legacy_blob" | "missing";
  standingWindows?: WeeklyWindows[];
  standingSource?: "unavailable" | "week" | "template" | "none";
  savedAt?: string | null;
  templateUpdatedAt?: string | null;
  publication?: {created:number;removed:number;awaitingTeam:number;attached?:number;detached?:number};
  conflictedBookings?: number;
  appointments?: string[];
  error?: string;
};
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
function displayClock(minutes: number) {
  const hour = Math.floor(minutes / 60);
  return String(hour % 12 || 12) + ":" +
    String(minutes % 60).padStart(2, "0") + (hour < 12 ? " AM" : " PM");
}
export default function StaffAvailabilityPage() {
  const [approvalSource,setApprovalSource]=useState<"ea" | "founder">("ea");
  // Upcoming Monday is the safe default. The active week is never selected implicitly.
  const [week, setWeek] = useState(() => interviewWeekChoices().next);
  const [acknowledgeCurrentWeek, setAcknowledgeCurrentWeek] = useState(false);
  const choices = interviewWeekChoices();
  const currentWeek = week === choices.current;
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "ea" | "chapter_admin">("ea");
  const [days, setDays] = useState<TimeWindow[][]>(emptyWeek);
  const [savedDays, setSavedDays] = useState<TimeWindow[][]>(emptyWeek);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [standingSource, setStandingSource] = useState<NonNullable<Payload["standingSource"]>>("none");
  const pendingNotice = useRef("");
  const [confirmation, setConfirmation] = useState<WeeklyConfirmation | null>(null);
  const [templateRevision, setTemplateRevision] = useState<string | null>(null);
  const [confirmationRevision, setConfirmationRevision] = useState<string | null>(null);
  const [confirmationSource, setConfirmationSource] = useState<Payload["confirmationSource"]>();
  const [phase, setPhase] = useState<"loading" | "logged-out" | "ready" | "unavailable">("loading");
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  // Founder-only: /interview/staff/availability?as=person@campus2care.org edits that person's hours.
  const [actingFor] = useState(() => typeof window === "undefined" ? ""
    : (new URLSearchParams(window.location.search).get("as") ?? "").trim().toLowerCase());
  const [onBehalf, setOnBehalf] = useState(false);
  const founderManaged = approvalSource === "founder" && !(email === "ryan.daves@campus2care.org" && role === "chapter_admin" && !onBehalf);

  useEffect(() => {
    let active = true;
    void fetch("/api/interview/staff/availability?week=" + encodeURIComponent(week) +
      (actingFor ? "&as=" + encodeURIComponent(actingFor) : ""), { cache: "no-store" })
      .then(async (response) => ({ response, data: await response.json() as Payload }))
      .then(({ response, data }) => {
        if (!active) return;
        setError("");
        if (pendingNotice.current) { setNotice(pendingNotice.current); pendingNotice.current = ""; }
        else setNotice("");
        if (response.status === 401) {
          if (new URLSearchParams(window.location.search).get("auth") === "failed") {
            setError("Sign-in could not be completed. Use an approved Campus2Care Workspace account or contact your coordinator.");
          }
          setPhase("logged-out"); return;
        }
        if (response.status === 403 && data.error === "not_on_interviewer_roster") {
          throw new Error("You're signed in, but you aren't on the interviewer roster yet. Ask Andrew to add your Campus2Care email.");
        }
        if (!response.ok || !data.ok || !data.email) throw new Error(data.error ?? "service_unavailable");
        setOnBehalf((data as Payload & { onBehalf?: boolean }).onBehalf === true);
        setApprovalSource(data.approvalSource ?? "ea");
        setEmail(data.email);
        setRole(data.role === "admin" ? "admin" : data.role === "chapter_admin" ? "chapter_admin" : "ea");
        setTemplateRevision(data.templateRevision ?? null);
        setConfirmationRevision(data.confirmationRevision ?? null);
        setConfirmationSource(data.confirmationSource);
        setConfirmation(data.confirmation ?? null);
        const shown = data.standingWindows
          ? fromRows(data.standingWindows)
          : fromRows(data.confirmation?.recurringWindows ?? data.template?.recurringWindows ?? []);
        if (!data.standingWindows) {
          for (const override of data.confirmation?.overrides ?? []) {
            const day = DAYS.findIndex((_, i) => dateInWeek(week, i) === override.date);
            if (day >= 0) shown[day] = override.kind === "unavailable" ? [] : (override.windows ?? []).map((w) => ({ ...w }));
          }
        }
        const copy = (rows: TimeWindow[][]) => rows.map((items) => items.map((item) => ({ ...item })));
        setSavedDays(copy(shown)); setDays(copy(shown));
        setSavedAt(data.savedAt ?? data.templateUpdatedAt ?? null);
        setStandingSource(data.standingSource ?? (data.template ? "template" : "none"));
        setPhase("ready");
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "service_unavailable");
        setPhase("unavailable");
      });
    return () => { active = false; };
  }, [week, reloadKey, actingFor]);

  const hoursOf = (rows: TimeWindow[][]) => rows.reduce(
    (total, day) => total + day.reduce((sum, window) => sum + Math.max(0, window.endMinute - window.startMinute), 0),
    0,
  ) / 60;
  const savedHours = useMemo(() => hoursOf(savedDays), [savedDays]);
  const dirty = JSON.stringify(days) !== JSON.stringify(savedDays);
  // The same slot generator as booking, run on the hours that are already saved.
  const slotPreview = useMemo<{ slots: InterviewSlot[]; valid: boolean }>(() => {
    try {
      return {
        valid: true,
        slots: buildInterviewSlots({
          eaId: email || "preview@campus2care.org",
          weekStart: week,
          status: "confirmed",
          confirmedAt: savedAt ?? "2026-01-01T00:00:00.000Z",
          recurringWindows: toRows(savedDays),
          overrides: [],
        }),
      };
    } catch {
      return { valid: false, slots: [] };
    }
  }, [savedDays, savedAt, email, week]);
  const noInterviewsThisWeek = standingSource === "unavailable" || confirmation?.status === "unavailable";
  const previewSlots = noInterviewsThisWeek ? [] : slotPreview.slots;
  const displayedHours = noInterviewsThisWeek ? 0 : savedHours;
  const savedLabel = savedAt
    ? "Saved · last updated " + new Date(savedAt).toLocaleString("en-US", {
      timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short",
    }) + " ET"
    : "Not saved yet";

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

  async function save(action: "template" | "confirm", status: "confirmed" | "unavailable" = "confirmed", acknowledgedAppointments: string[] = []) {
    setError(""); setNotice("");
    if (action === "confirm" && founderManaged) {
      setError("This week is founder-approved. Request a schedule change from the founder; editing hours here cannot replace published interviews.");
      return;
    }
    if (action === "confirm" && currentWeek && !acknowledgeCurrentWeek) {
      setError("To change the current week, acknowledge that existing appointments may already be scheduled.");
      return;
    }
    const hasHours = days.some((day) => day.some((window) => window.endMinute > window.startMinute));
    if (status !== "unavailable" && !hasHours) {
      setError("Add at least one time window before saving. To offer no interviews, choose “No interviews during selected week.” That applies only to the selected week and does not clear future weeks.");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch("/api/interview/staff/availability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action, weekStart: week, status, acknowledgedAppointments, ...(onBehalf ? { asEmail: email } : {}),
          acknowledgeCurrentWeek: action === "confirm" && currentWeek && acknowledgeCurrentWeek,
          revision: action === "template" ? templateRevision : confirmationRevision,
          recurringWindows: toRows(days),
          overrides: [],
        }),
      });
      const data = await response.json() as Payload & { revision?: string };
      if (!response.ok || !data.ok) {
        if (data.error === "booking_warning_required" && data.appointments?.length) {
          const times = data.appointments.map(time => new Date(time).toLocaleString("en-US", {timeZone:"America/New_York",dateStyle:"medium",timeStyle:"short"})).join("\n");
          if (window.confirm("These booked interviews fall outside your new hours (Eastern Time):\n" + times +
            "\n\nThey will stay booked and will NOT be canceled or moved. Coordinate these appointments with your team. Save the remaining schedule changes?")) {
            await save(action, status, data.appointments);
          }
          return;
        }
        if (data.error === "empty_availability_windows") {
          throw new Error("Add at least one time window before saving. To offer no interviews, choose “No interviews during selected week.” That applies only to the selected week and does not clear future weeks.");
        }
        if (data.error === "current_week_acknowledgement_required") {
          throw new Error("Review and acknowledge the current-week booking warning before saving.");
        }
        if (data.error === "founder_managed_week") {
          throw new Error("This schedule was approved by the founder and cannot be replaced here. Contact leadership to request a change.");
        }
        if (response.status === 409) throw new Error("Someone updated this schedule elsewhere. Reload before saving.");
        throw new Error(data.error === "invalid_availability"
          ? "Check that each time window ends after it starts, uses five-minute times, and does not overlap another window."
          : "Your availability could not be saved. Try again shortly.");
      }
      const conflictNote = data.conflictedBookings
        ? " " + data.conflictedBookings + " existing booking(s) now conflict with these hours and must be reviewed by leadership."
        : "";
      const published = data.publication
        ? ` ${data.publication.created} open slot(s) published; ${data.publication.removed} unbooked slot(s) removed.` +
          ((data.publication.attached || data.publication.detached)
            ? ` Shadower assignments: ${data.publication.attached ?? 0} added, ${data.publication.detached ?? 0} removed.`
            : "") +
          (data.publication.awaitingTeam ? ` ${data.publication.awaitingTeam} time(s) were skipped because the lead is already booked then.` : "")
        : "";
      pendingNotice.current = (action === "template"
        ? "Saved. Later weeks use these hours. This founder-approved week was left as published."
        : status === "confirmed"
          ? "Saved. These hours repeat every week until you change them."
          : "No interviews for this week. Your saved hours for other weeks were kept.") +
        (currentWeek && action !== "template" ? " Existing appointments were not canceled or moved." : "") +
        published + conflictNote;
      setAcknowledgeCurrentWeek(false);
      setReloadKey((key) => key + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save.");
    } finally { setSaving(false); }
  }

  const weeks = Array.from({ length: 5 }, (_, i) => atDate(choices.current, i * 7));
  const chooseWeek = (date: string) => {
    if (date === week) return;
    setPhase("loading");
    setAcknowledgeCurrentWeek(false);
    setNotice(""); setError("");
    setWeek(date);
  };
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
            {(role === "admin" || role === "chapter_admin") && phase === "ready" && <a href="/interview/admin" className="text-[#b3131b] underline">Leadership dashboard</a>}
            {phase === "ready" && <button className="rounded-full border border-black/15 px-4 py-2" onClick={async () => {
              await fetch("/api/interview/auth/logout", { method: "POST" }); window.location.reload();
            }}>Sign out</button>}
          </div>
        </header>
        <div className="mb-8">
          <span className="text-xs font-black uppercase tracking-[.15em] text-[#b3131b]">Staff schedule</span>
          <h1 className="mt-2 text-3xl font-black tracking-tight sm:text-5xl">Interview availability</h1>
          <p className="mt-3 max-w-2xl text-base text-stone-600">Save your hours once. They repeat every week and are what the scheduler uses. You do not need to confirm each week. Marking one week as no interviews does not erase the rest. An interview needs a lead. A shadower is added only when their saved hours overlap that time.</p>
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
            <div><p className="text-xs font-bold uppercase tracking-widest text-stone-500">{onBehalf ? (role === "chapter_admin" ? "Editing availability for your team member" : "Founder editing availability for") : "Signed in"}</p>
              <p className="font-semibold">{email}</p>
              {onBehalf && <a className="text-sm underline" href="/interview/admin">{role === "chapter_admin" ? "Back to dashboard" : "Back to founder dashboard"}</a>}</div>
            <label className="text-sm font-semibold">Other upcoming weeks
              <select disabled={saving} className="ml-3 rounded-xl border border-stone-300 bg-white p-3"
                value={week} onChange={(e) => chooseWeek(e.target.value)}>
                {weeks.map((date) => <option key={date} value={date}>{date} to {atDate(date, 6)}</option>)}
              </select>
            </label>
          </div>
          <fieldset className="mb-6 rounded-2xl border border-stone-200 bg-white p-5" disabled={saving}
            aria-label="Choose which interview week to update">
            <legend className="px-2 text-sm font-black">Apply my availability to</legend>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <label className={`flex cursor-pointer gap-3 rounded-xl border p-4 ${week === choices.next ? "border-[#b3131b] bg-red-50" : "border-stone-200"}`}>
                <input type="radio" name="target-interview-week" value={choices.next}
                  checked={week === choices.next} onChange={() => chooseWeek(choices.next)} />
                <span><strong className="block">Next week (recommended)</strong>
                  <span className="mt-1 block text-sm text-stone-600">{choices.next} to {atDate(choices.next, 6)} · starts Monday</span>
                  <span className="mt-1 block text-xs text-stone-600">Keep this week&apos;s schedule untouched.</span></span>
              </label>
              <label className={`flex cursor-pointer gap-3 rounded-xl border p-4 ${currentWeek ? "border-amber-500 bg-amber-50" : "border-stone-200"}`}>
                <input type="radio" name="target-interview-week" value={choices.current}
                  checked={currentWeek} onChange={() => chooseWeek(choices.current)} />
                <span><strong className="block">Change this week</strong>
                  <span className="mt-1 block text-sm text-stone-600">{choices.current} to {atDate(choices.current, 6)}</span>
                  <span className="mt-1 block text-xs text-amber-800">Requires an appointment safety warning and acknowledgement.</span></span>
              </label>
            </div>
            <p className="mt-3 text-xs text-stone-600">
              Saving applies from the selected week forward. A week marked no interviews, and a founder-approved week, stay as they are.
            </p>
          </fieldset>
          {currentWeek && <section role="alert" className="mb-5 rounded-xl border border-amber-400 bg-amber-50 p-5 text-sm text-amber-950">
            <p className="font-black">Warning: changing this week&apos;s schedule may conflict with appointments already booked.</p>
            <p className="mt-2">Changing your availability will never cancel, move, or erase a confirmed interview or its Google Calendar invitation. 
              Any appointments outside your new hours must be reviewed with leadership. Changes also cannot replace founder-published slots automatically.</p>
            {!founderManaged && <label className="mt-4 flex items-start gap-3 font-semibold">
              <input type="checkbox" className="mt-1" checked={acknowledgeCurrentWeek}
                onChange={(e) => setAcknowledgeCurrentWeek(e.target.checked)} />
              <span>I understand that interviews may already be scheduled and that I must coordinate any conflicts with leadership.</span>
            </label>}
          </section>}
          {founderManaged && <p role="status" className="mb-5 rounded-xl border border-blue-300 bg-blue-50 p-4 font-semibold text-blue-950">
            Founder-approved for {week} to {atDate(week, 6)}. Existing published interview times are protected and are not replaced. Saving hours updates later weeks only.
          </p>}
          <InterviewTeamSchedule key={week + confirmationRevision} week={week} />
          {confirmationSource === "legacy_blob" && <div role="status"
            className="mb-5 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
            This week&apos;s earlier confirmation is still in the legacy preview store.
            Review the hours and press “Confirm my hours for this week” again
            to record them in the staging database. Previously entered hours are preserved.
          </div>}
          <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-2xl border border-black/10 bg-white p-5"><p className="text-xs font-bold uppercase text-stone-500">Schedule status</p>
              <p className="mt-2 text-xl font-black">{approvalSource === "founder" ? "Founder-approved" : noInterviewsThisWeek ? "No interviews" : savedAt ? "Saved" : "Not saved"}</p>
              <p className="mt-1 text-xs text-stone-600">{savedLabel}</p></div>
            <div className="rounded-2xl border border-black/10 bg-white p-5"><p className="text-xs font-bold uppercase text-stone-500">Hours on the schedule</p>
              <p className="mt-2 text-xl font-black">{displayedHours.toFixed(1)} hours</p>
              {noInterviewsThisWeek && <p className="mt-1 text-xs text-stone-600">
                This week offers no interviews. Saved hours for other weeks stay in place.
              </p>}
              {dirty && <p className="mt-1 text-xs text-amber-800">Unsaved edits are not on the schedule yet.</p>}
            </div>
            <div className="rounded-2xl border border-black/10 bg-white p-5"><p className="text-xs font-bold uppercase text-stone-500">Saved 20-minute slots</p>
              <p className="mt-2 text-xl font-black">{previewSlots.length}</p>
              <p className="mt-1 text-xs text-stone-600">From the saved hours, not from unsaved edits</p>
            </div>
          </div>
          <section className="rounded-2xl border border-black/10 bg-white p-5 sm:p-8">
            <div className="mb-6">
              <h2 className="text-xl font-black">Your weekly hours</h2>
              <p className="mt-1 text-sm font-semibold text-stone-700" role="status">{savedLabel}{dirty ? " · unsaved edits" : ""}</p>
              <p className="mt-1 text-sm text-stone-600">All times Eastern. These are the hours stored for the scheduler. Add a window or leave a day empty, then save. You do not confirm again each week.</p>
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
            <section aria-label="Interview slot preview" className="mt-7 rounded-2xl border border-stone-200 bg-stone-50 p-5">
              <h3 className="text-lg font-black">Slots from your saved hours</h3>
              <p className="mt-2 text-sm text-stone-600">
                These times come from the hours already saved. Unsaved edits above are not included. A shadower does not create a separate interview.
              </p>
              {noInterviewsThisWeek ? (
                <p role="status" className="mt-4 rounded-lg bg-white p-4 text-sm font-semibold">
                  0 interviews offered this week. Other weeks still use your saved hours.
                </p>
              ) : !slotPreview.valid ? (
                <p role="alert" className="mt-4 rounded-lg bg-amber-50 p-4 text-sm text-amber-900">
                  Fix any invalid or overlapping time blocks to see the proposed appointments.
                </p>
              ) : previewSlots.length === 0 ? (
                <p className="mt-4 text-sm text-stone-600">
                  No 20-minute appointments fit the time blocks entered.
                </p>
              ) : (
                <div className="mt-4 space-y-3">
                  <p className="text-sm font-bold">
                    {previewSlots.length} saved interview{previewSlots.length === 1 ? "" : "s"} from {savedHours.toFixed(1)} hours
                  </p>
                  {DAYS.map((day, i) => {
                    const daySlots = previewSlots.filter((slot) => slot.date === dateInWeek(week, i));
                    if (daySlots.length === 0) return null;
                    return (
                      <details key={day} className="rounded-xl border border-stone-200 bg-white p-3" open={i === 0}>
                        <summary className="cursor-pointer font-semibold">
                          {day} ({daySlots.length} slots)
                        </summary>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {daySlots.map((slot) => (
                            <span key={slot.date + "-" + slot.startMinute}
                              className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs font-medium">
                              {displayClock(slot.startMinute)} to {displayClock(slot.endMinute)}
                            </span>
                          ))}
                        </div>
                      </details>
                    );
                  })}
                </div>
              )}
              <p className="mt-4 text-xs text-stone-600">
                A lead&apos;s saved hours become bookable slots. A shadower is attached when their saved hours cover that time. Booked interviews are not moved.
              </p>
            </section>
            {error && <p role="alert" className="mt-5 rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</p>}
            {notice && <p role="status" className="mt-5 rounded-lg bg-green-50 p-3 text-sm text-green-900">{notice}</p>}
            <div className="mt-6 flex flex-wrap gap-3 border-t border-stone-200 pt-6">
              <button disabled={saving || (!founderManaged && currentWeek && !acknowledgeCurrentWeek)}
                onClick={() => void save(founderManaged ? "template" : "confirm")} className="button button-primary disabled:opacity-50">
                {saving ? "Saving…" : "Save my hours"}
              </button>
              <button disabled={saving || founderManaged || (currentWeek && !acknowledgeCurrentWeek)}
                onClick={() => void save("confirm", "unavailable")} className="button button-secondary disabled:opacity-50">
                No interviews during selected week
              </button>
            </div>
            <p className="mt-4 text-xs text-stone-500">
              Saving writes the hours on this page and repeats them from {week} forward. Previously booked interviews stay on their original calendars.
              An active lead&apos;s open times are published. A shadower is added only when their saved hours overlap. A founder-managed week is not replaced.
            </p>
          </section>
        </>}
      </div>
    </main>
  );
}
