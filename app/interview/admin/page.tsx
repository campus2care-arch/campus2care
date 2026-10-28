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
  confirmationSource?: "postgres" | "legacy_blob" | "missing";
  bookableInDb?: boolean;
  interviewerActive?: boolean | null;
  weeklyCapacityLimit?: number | null;
};
type QueueStatus = {
  pending:number;processing:number;retry:number;reconciliation:number;failed:number;
};
type Connection = { provider: string; account: string; verified: boolean; check: string; errorCode: string | null };
type ProviderTest = { runId: string; state: string; idempotent: boolean; meetReady: boolean; canceled: boolean; errorCode: string | null };
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
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [error, setError] = useState("");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [providerTest, setProviderTest] = useState<ProviderTest | null>(null);
  const [providerBusy, setProviderBusy] = useState(false);
  const [providerError, setProviderError] = useState("");
  const [syntheticBusy, setSyntheticBusy] = useState(false);
  const [syntheticUrl, setSyntheticUrl] = useState("");
  const [syntheticError, setSyntheticError] = useState("");
  const [syntheticExpiry, setSyntheticExpiry] = useState("");
  async function createSyntheticInvitation() {
    setSyntheticBusy(true); setSyntheticError(""); setSyntheticUrl("");
    try {
      const response = await fetch("/api/interview/admin/synthetic-invitation", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campus: "BU" }), cache: "no-store",
      });
      const data = await response.json() as { ok?: boolean; url?: string; expiresAt?: string; error?: string };
      if (!response.ok || !data.ok || !data.url) {
        throw new Error(data.error === "bob_has_no_active_confirmed_capacity"
          ? "Bob needs active staging capacity and confirmed hours first."
          : data.error === "synthetic_booking_not_enabled"
          ? "The synthetic booking test has not been enabled in staging."
          : data.error === "synthetic_invitation_limit_reached"
          ? "Five test links have already been issued this hour."
          : "Could not create a test link.");
      }
      setSyntheticUrl(data.url); setSyntheticExpiry(data.expiresAt ?? "");
    } catch (error) {
      setSyntheticError(error instanceof Error ? error.message : "Could not generate a test link.");
    } finally { setSyntheticBusy(false); }
  }
  async function checkConnections() {
    setProviderBusy(true); setProviderError("");
    try {
      const response = await fetch("/api/interview/admin/providers", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error("Could not check connections.");
      setConnections(body.connections); setProviderTest(body.lastTest);
    } catch { setProviderError("Could not check connections. Try again shortly."); }
    finally { setProviderBusy(false); }
  }
  async function verifyCalendar(cleanupOnly = false) {
    const runId = providerTest && (!providerTest.canceled || cleanupOnly) ? providerTest.runId : crypto.randomUUID();
    setProviderBusy(true); setProviderError("");
    if (!cleanupOnly) setProviderTest({ runId, state: "processing", idempotent: false, meetReady: false, canceled: false, errorCode: null });
    try {
      const response = await fetch("/api/interview/admin/providers", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, action: cleanupOnly ? "cleanup_calendar" : "verify_calendar" }),
      });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error("Verification could not finish.");
      setProviderTest(body.test);
    } catch { setProviderError("Verification could not finish. Check status and reconcile this test before starting another."); }
    finally { setProviderBusy(false); }
  }
  useEffect(() => {
    let live = true;
    async function loadConnections() {
      try {
        const response = await fetch("/api/interview/admin/providers", { cache: "no-store" });
        const body = await response.json();
        if (!response.ok || !body.ok) throw new Error("connection_status_unavailable");
        if (live) { setConnections(body.connections); setProviderTest(body.lastTest); }
      } catch {
        if (live) setProviderError("Could not check connections. Use Check connections to retry.");
      }
    }
    void loadConnections();
    return () => { live = false; };
  }, []);
  useEffect(() => {
    let live = true;
    async function load() {
      setLoading(true); setError("");
      try {
        const response = await fetch("/api/interview/admin/readiness?week=" + week, { cache: "no-store" });
        const result = await response.json() as ResponseBody;
        if (!response.ok || !result.ok) throw new Error(result.error ?? "readiness_unavailable");
        if (live) setData(result);
        const outbox = await fetch("/api/interview/admin/outbox", { cache:"no-store" })
          .then(async (response) => {
            if (!response.ok) return null;
            const body = await response.json() as {ok?:boolean;queues?:QueueStatus};
            return body.ok ? body.queues ?? null : null;
          }).catch(() => null);
        if (live) setQueueStatus(outbox);
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
          <section className="mb-7 rounded-2xl border border-black/10 bg-white p-5">
            <h2 className="text-lg font-black">Google service connections</h2>
            <p className="mt-2 text-sm text-stone-600">Account connections are verified automatically when this dashboard opens. Use Check connections to refresh their status.</p>
            <div className="mt-4 flex flex-wrap gap-3">
              <a className="rounded-full border border-black/15 px-4 py-2 text-sm font-semibold" href="/api/interview/providers/google/start?provider=calendar">Connect interviews@ Calendar</a>
              <a className="rounded-full border border-black/15 px-4 py-2 text-sm font-semibold" href="/api/interview/providers/google/start?provider=gmail">Connect contact@ Gmail</a>
            </div>
            <div className="mt-4 flex flex-wrap gap-3">
              <button disabled={providerBusy} className="rounded-full border border-black/15 px-4 py-2 text-sm font-semibold disabled:opacity-50" onClick={() => void checkConnections()}>Check connections</button>
              <button disabled={providerBusy || !!providerTest && !providerTest.canceled} className="rounded-full border border-black/15 px-4 py-2 text-sm font-semibold disabled:opacity-50" onClick={() => void verifyCalendar()}>Run synthetic Calendar check</button>
              {providerTest && !providerTest.canceled && <button disabled={providerBusy} className="rounded-full border border-black/15 px-4 py-2 text-sm font-semibold disabled:opacity-50" onClick={() => void verifyCalendar(true)}>Reconcile test</button>}
            </div>
            <p className="mt-2 text-xs text-stone-500">The synthetic check creates an event with no guests, verifies its individual Meet link, and cancels it.</p>
            {providerBusy && <p role="status" className="mt-3 text-sm">Checking Google services…</p>}
            {providerError && <p role="alert" className="mt-3 text-sm text-red-800">{providerError}</p>}
            <div aria-live="polite" className="mt-3 space-y-2 text-sm">
              {connections.map((connection) => <p key={connection.provider}><strong>{connection.account}</strong>: {connection.verified ? connection.check : connection.errorCode}</p>)}
              {providerTest && <p>Synthetic Calendar test: {providerTest.state === "done" ? "Passed. Unique event and Meet link verified; event canceled." : providerTest.state + (providerTest.errorCode ? " (" + providerTest.errorCode + ")" : "")}</p>}
            </div>
          </section>
          <section className="mb-7 rounded-2xl border border-black/10 bg-white p-5">
            <h2 className="text-lg font-black">Test student booking with Bob</h2>
            <p className="mt-2 text-sm text-stone-600">
              Creates a temporary fake Boston University applicant link in staging. Only Bob&apos;s
              approved, confirmed hours are eligible. This test holds a 20-minute slot with a 5-minute
              buffer; it will not email a student or create a Google Calendar event.
            </p>
            <button type="button" disabled={syntheticBusy}
              onClick={() => void createSyntheticInvitation()}
              className="mt-4 rounded-full bg-[#b3131b] px-5 py-3 text-sm font-bold text-white disabled:opacity-50">
              {syntheticBusy ? "Generating…" : "Generate test student booking link"}
            </button>
            {syntheticError && <p role="alert" className="mt-3 text-sm text-red-800">{syntheticError}</p>}
            {syntheticUrl && <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50 p-4">
              <p className="text-sm font-bold">Fake BU applicant link created</p>
              <p className="mt-1 text-xs text-stone-600">
                Open this in a private window to experience the volunteer side of scheduling.
                The link expires {syntheticExpiry ? new Date(syntheticExpiry).toLocaleString() : "in one hour"}.
                Do not share it with real volunteers.
              </p>
              <div className="mt-3 flex flex-wrap gap-3">
                <a href={syntheticUrl} target="_blank" rel="noreferrer noopener"
                  className="rounded-full border border-black/15 bg-white px-4 py-2 text-sm font-semibold">
                  Open test booking page
                </a>
                <button type="button" onClick={() => void navigator.clipboard.writeText(syntheticUrl)}
                  className="rounded-full border border-black/15 bg-white px-4 py-2 text-sm font-semibold">
                  Copy test link
                </button>
              </div>
            </div>}
            <p className="mt-3 text-xs text-stone-500">
              This is a database-only reservation trial. It does not confirm or send a real
              interview. The Gmail and Calendar workers remain disabled.
            </p>
          </section>
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
          <p className="mb-4 text-xs text-stone-500">Potential slots are preliminary. Legacy weeks must be reconfirmed in Neon. Confirmed bookings, Google Calendar conflicts, and cancellation adjustments are not yet deducted.</p>
          {queueStatus && <section className="mb-7 rounded-2xl border border-black/10 bg-white p-5">
            <h2 className="text-lg font-black">Integration queue health</h2>
            <p className="mt-1 text-xs text-stone-600">
              Staging-only counts. External Gmail, Google Calendar, and Notion workers remain disabled.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-5">
              {[
                ["Queued", queueStatus.pending], ["Processing", queueStatus.processing],
                ["Retry pending", queueStatus.retry],
                ["Needs reconciliation", queueStatus.reconciliation],
                ["Failed", queueStatus.failed],
              ].map(([name, count]) => <div key={String(name)}
                className="rounded-xl bg-stone-50 p-3">
                <p className="text-xs text-stone-500">{name}</p>
                <p className="mt-1 text-xl font-bold">{count}</p>
              </div>)}
            </div>
          </section>}
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
                  <span className="text-sm text-stone-600">{row.bookableInDb === false
                    ? row.confirmationSource === "legacy_blob"
                      ? "Reconfirmation needed"
                      : "Interviewer approval pending"
                    : Math.min(row.openSlotCount, row.weeklyCapacityLimit ?? row.openSlotCount)
                      + " potential slots"}</span>
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
