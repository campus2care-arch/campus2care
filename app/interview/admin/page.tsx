"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import logo from "../../../public/images/C2C-logo.png";
import { mondayForDate } from "../../../lib/interview-availability";

type ReadinessRow = {
  eaId: string;
  status: "missing" | "pending" | "confirmed" | "unavailable";
  isResponded: boolean;
  openSlotCount: number;
  confirmedAt: string | null;
};
type ResponseBody = {
  ok?: boolean; error?: string; week?: string;
  availability?: ReadinessRow[];
  totalStaff?: number; confirmedCount?: number;
  respondedCount?: number; potentialSlots?: number;
};

function firstUpcomingWeek() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const p = (kind: string) => parts.find((x) => x.type === kind)?.value ?? "";
  const monday = mondayForDate(p("year") + "-" + p("month") + "-" + p("day"));
  const d = new Date(monday + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}

function addDays(date: string, days: number) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export default function InterviewAdminPage() {
  const [week, setWeek] = useState(firstUpcomingWeek);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ResponseBody | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    async function load() {
      setLoading(true); setError("");
      try {
        const response = await fetch("/api/interview/admin/readiness?week=" + week, { cache: "no-store" });
        const result = await response.json() as ResponseBody;
        if (!response.ok || !result.ok) throw new Error(result.error ?? "readiness_unavailable");
        if (live) setData(result);
      } catch (err) {
        if (live) { setData(null); setError(err instanceof Error ? err.message : "Could not load"); }
      } finally { if (live) setLoading(false); }
    }
    void load();
    return () => { live = false; };
  }, [week]);
  const options = Array.from({ length: 5 }, (_, i) => addDays(firstUpcomingWeek(), (i - 1) * 7));
  const missing = data?.availability?.filter((row) => !row.isResponded).length ?? 0;
  return (
    <main className="min-h-screen bg-[#f7f7f4] px-4 py-8 text-[#20201d] sm:px-8">
      <div className="mx-auto max-w-6xl">
        <header className="mb-9 flex flex-wrap items-center justify-between gap-4 border-b border-black/10 pb-6">
          <Link href="/" className="flex items-center gap-3">
            <Image src={logo} alt="Campus2Care" width={56} height={56} className="rounded-xl object-contain" />
            <div><p className="text-xs font-bold uppercase tracking-widest text-[#b3131b]">Campus2Care</p>
              <p className="text-lg font-black">Interview Operations</p></div>
          </Link>
          <Link className="rounded-full border border-black/15 px-4 py-2 text-sm font-semibold" href="/interview/staff/availability">
            My availability
          </Link>
        </header>
        <div className="mb-8 flex flex-wrap items-end justify-between gap-5">
          <div><p className="text-xs font-black uppercase tracking-widest text-[#b3131b]">Leadership-only</p>
            <h1 className="mt-2 text-3xl font-black sm:text-5xl">EA interview readiness</h1>
            <p className="mt-3 text-stone-600">Weekly confirmations across the active EA roster. Upcoming candidate invitations are not enabled yet.</p></div>
          <label className="text-sm font-bold">Week of
            <select className="ml-3 rounded-xl border border-stone-300 bg-white p-3" value={week} onChange={(event) => setWeek(event.target.value)}>
              {options.map((value) => <option key={value} value={value}>{value} – {addDays(value, 6)}</option>)}
            </select>
          </label>
        </div>
        {loading && <div className="rounded-2xl bg-white p-7">Loading team readiness…</div>}
        {!loading && error && <div role="alert" className="rounded-2xl border border-amber-300 bg-amber-50 p-7">
          <p className="text-lg font-bold">Protected dashboard is unavailable</p>
          <p className="mt-2 text-sm text-amber-900">{error === "admin_access_required"
            ? "This account does not have leadership access. Sign in with an approved leadership account."
            : "The team schedule could not be loaded. Try again shortly."}</p>
          <a className="button button-primary mt-5" href="/api/interview/auth/start?returnTo=%2Finterview%2Fadmin">Sign in as leadership</a>
        </div>}
        {!loading && data?.ok && <>
          <div className="mb-7 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              ["Active interviewers", data.totalStaff ?? 0],
              ["EAs with confirmed hours", data.confirmedCount ?? 0],
              ["Awaiting a response", missing],
              ["Potential interview slots", data.potentialSlots ?? 0],
            ].map(([label, count]) => <div key={String(label)} className="rounded-2xl border border-black/10 bg-white p-5">
              <p className="text-xs font-bold uppercase tracking-wide text-stone-500">{label}</p>
              <p className="mt-3 text-3xl font-black">{count}</p>
            </div>)}
          </div>
          <p className="mb-4 text-xs text-stone-500">Potential slots are preliminary. Confirmed bookings, Google Calendar conflicts, and cancellation adjustments are not yet deducted.</p>
          <section className="overflow-hidden rounded-2xl border border-black/10 bg-white">
            <div className="border-b border-black/10 p-5">
              <h2 className="text-xl font-black">Weekly EA responses</h2>
              <p className="mt-1 text-sm text-stone-600">The leadership roster is controlled by Workspace email allowlist until the full role-management system launches.</p>
            </div>
            <div className="divide-y divide-stone-100">
              {data.availability?.map((row) => <div key={row.eaId} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                <div><p className="font-semibold">{row.eaId}</p>
                  <p className="text-xs text-stone-500">{row.confirmedAt ? "Last confirmed: " + new Date(row.confirmedAt).toLocaleString() : "No weekly response recorded"}</p></div>
                <div className="flex items-center gap-4">
                  <span className="text-sm text-stone-600">{row.openSlotCount} potential slots</span>
                  <span className={"rounded-full px-3 py-1 text-xs font-bold " +
                    (row.status === "confirmed" ? "bg-green-100 text-green-800" :
                      row.status === "unavailable" ? "bg-stone-200 text-stone-700" :
                        "bg-amber-100 text-amber-800")}>{row.status}</span>
                </div>
              </div>)}
              {!data.availability?.length && <p className="p-6 text-sm text-stone-600">No active EA emails are configured yet.</p>}
            </div>
          </section>
        </>}
      </div>
    </main>
  );
}
