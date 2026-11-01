"use client";
import { useEffect, useMemo, useState } from "react";

type Campus = "BU" | "BC";
type Row = { key: string; campus: Campus; name: string; email: string; eaOwner: string | null;
  interviewStatus: string | null; interviewDate: string | null; invitationsSent: number; lastInvitationAt: string | null;
  booking: "none" | "active" | "completed"; decision: string; nextAction: string; invitable: boolean; frequencyLimited: boolean };
// Same rule as the "Need interviews" card on the server.
const NOT_NEEDING = ["archived", "applicant_inactive", "suppressed_or_opted_out", "not_approved_to_invite", "workflow_status_not_eligible", "interview_already_processed"];
type Summary = { needingInterview: number; invitationsSent: number; scheduled: number; completed: number;
  awaitingResponse: number; openSlots: number; remainingCapacity: number };
type Mismatch = { key: string; name: string; campus: Campus; issue: string };
type View = "needing" | "eligible" | "awaiting" | "history" | "scheduled" | "all";

const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" }) : "—";
const ERRORS: Record<string, string> = {
  audience_review_disabled: "Live applicant data is switched off (INTERVIEW_PRODUCTION_APPLICANT_REVIEW_ENABLED). Interviewer tools below still work.",
  founder_access_required: "Sign in as president@campus2care.org to see applicant data.",
};

/** Hands the chosen applicants to the approval panel below; nothing is sent from here. */
function selectForApproval(keys: string[]) {
  window.dispatchEvent(new CustomEvent("c2c-select-applicants", { detail: { keys } }));
  document.getElementById("applicant-invitations")?.scrollIntoView({ behavior: "smooth" });
}

export default function FounderDashboard({ campus, onCampus }: { campus: Campus | "ALL"; onCampus: (c: Campus | "ALL") => void }) {
  const [data, setData] = useState<{ summary: Summary; applicants: Row[]; mismatches: Mismatch[] } | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [view, setView] = useState<View>("needing");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    fetch("/api/interview/admin/dashboard?campus=" + campus, { cache: "no-store" })
      .then(async (r) => { const body = await r.json(); if (!r.ok || !body.ok) throw new Error(body.error ?? "dashboard_unavailable"); return body; })
      .then((body) => { if (live) { setData(body); setError(""); } })
      .catch((e: unknown) => { if (live) { setData(null); const code = e instanceof Error ? e.message : "dashboard_unavailable"; setError(ERRORS[code] ?? code.replaceAll("_", " ")); } });
    return () => { live = false; };
  }, [campus, reload]);

  const rows = useMemo(() => {
    const all = data?.applicants ?? [];
    const pick: Record<View, (r: Row) => boolean> = {
      needing: (r) => r.interviewStatus === "Not Scheduled" && r.booking === "none" && !NOT_NEEDING.includes(r.decision),
      eligible: (r) => r.invitable,
      awaiting: (r) => r.invitationsSent > 0 && r.booking === "none" && r.interviewStatus === "Not Scheduled",
      history: (r) => r.invitationsSent > 0,
      scheduled: (r) => r.booking === "active" || r.interviewStatus === "Scheduled",
      all: () => true,
    };
    const q = search.trim().toLowerCase();
    return all.filter(pick[view]).filter((r) => !q || r.name.toLowerCase().includes(q) || r.email.includes(q))
      .sort((a, b) => a.campus.localeCompare(b.campus) || a.name.localeCompare(b.name));
  }, [data, view, search]);
  const s = data?.summary;
  const eligible = (data?.applicants ?? []).filter((r) => r.invitable);
  const followUps = eligible.filter((r) => r.invitationsSent > 0);
  const cap = s?.remainingCapacity ?? 0;
  // "Needs interview" is the full follow-up population, not merely first-time
  // recipients. Retain those who previously received an invitation but never booked.
  const needCount = s?.needingInterview ?? 0;
  const readyCount = eligible.length;
  const waveCount = Math.min(readyCount,100);

  return <section className="space-y-5">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <h2 className="text-2xl font-black">Applicants and interviews</h2>
      <div className="flex gap-2">
        {(["ALL", "BU", "BC"] as const).map((c) => <button type="button" key={c} onClick={() => { setSelected(new Set()); onCampus(c); }}
          className={"rounded-full px-4 py-2 text-sm font-bold " + (campus === c ? "bg-[#b3131b] text-white" : "border border-stone-300")}>{c === "ALL" ? "All" : c}</button>)}
        <button type="button" onClick={() => setReload((n) => n + 1)} className="rounded-full border border-stone-300 px-4 py-2 text-sm">Refresh</button>
      </div>
    </div>
    {error && <p role="alert" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">{error}</p>}
    <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
      {([["Need interviews", s?.needingInterview], ["Invitations sent", s?.invitationsSent], ["Interviews scheduled", s?.scheduled],
        ["Interviews completed", s?.completed], ["Awaiting response", s?.awaitingResponse], ["Open 20-min slots", s?.openSlots]] as const)
        .map(([label, value]) => <div key={label} className="rounded-xl border border-black/10 bg-white p-4">
          <p className="text-xs text-stone-500">{label}</p><p className="mt-1 text-3xl font-black">{value ?? "–"}</p></div>)}
    </div>
    {s && <p className="text-sm text-stone-600">Currently bookable interview capacity: <strong>{cap}</strong>. This does not limit invitations. If appointments fill, invitees can book when new approved availability is added.</p>}
    {!!data?.mismatches.length && <details className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm">
      <summary className="cursor-pointer font-bold">{data.mismatches.length} status mismatch{data.mismatches.length === 1 ? "" : "es"} between Notion and bookings</summary>
      <ul className="mt-2 list-disc pl-5">{data.mismatches.map((m) => <li key={m.key + m.issue}>{m.campus} · {m.name}: {m.issue}</li>)}</ul>
    </details>}

    {data && <div className="rounded-2xl border border-black/10 bg-white p-5">
      <div className="flex flex-wrap items-center gap-2">
        {([["needing", "Needs interview"], ["eligible", "Eligible to invite"], ["awaiting", "Invited, not booked"],
          ["history", "Invitation history"], ["scheduled", "Scheduled interviews"], ["all", "Everyone"]] as const)
          .map(([v, label]) => <button type="button" key={v} onClick={() => setView(v)}
            className={"rounded-full px-3 py-1 text-sm " + (view === v ? "bg-stone-900 text-white" : "border border-stone-300")}>{label}</button>)}
        <input aria-label="Search applicants" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or email"
          className="ml-auto w-56 rounded-lg border border-stone-300 px-3 py-1.5 text-sm" />
      </div>
      <div className="mt-4 flex flex-wrap gap-2 text-sm">
        <button type="button" disabled={!selected.size} onClick={() => selectForApproval([...selected])}
          className="rounded-full bg-[#b3131b] px-4 py-2 font-bold text-white disabled:opacity-40">Invite selected ({selected.size})</button>
        <button type="button" disabled={!waveCount} onClick={() => selectForApproval(eligible.slice(0, waveCount).map((r) => r.key))}
          className="rounded-full border border-stone-300 px-4 py-2 font-semibold disabled:opacity-40">Prepare system-wide invitation wave ({waveCount} of {needCount} needing interviews)</button>
        <button type="button" disabled={!followUps.length} onClick={() => selectForApproval(followUps.slice(0, Math.max(cap, 0)).map((r) => r.key))}
          className="rounded-full border border-stone-300 px-4 py-2 font-semibold disabled:opacity-40">Follow up with {followUps.length} who haven&apos;t booked</button>
      </div>
      <p className="mt-2 text-xs text-stone-500">All {needCount} applicants still needing interviews remain in this dashboard, including previous invitees. {Math.max(0,needCount-waveCount)} may require identity, prior-outreach or status review; open slots never cap invitations. No applicant is silently marked interviewed or removed. Selecting a batch leads to founder review, then a separate Send approved invitations now action for manual waves. Your original approved interviewer slots remain the schedule of record until you edit them in the app.</p>
      <div className="mt-4 max-h-[36rem] overflow-auto">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="sticky top-0 bg-white text-xs uppercase text-stone-500"><tr>
            <th className="py-2"><input type="checkbox" aria-label="Select all invitable rows shown"
              checked={rows.some((r) => r.invitable) && rows.filter((r) => r.invitable).every((r) => selected.has(r.key))}
              onChange={(e) => setSelected(e.target.checked ? new Set(rows.filter((r) => r.invitable).map((r) => r.key)) : new Set())} /></th>
            <th>Name</th><th>Campus</th><th>Email</th><th>Interview status</th><th>Last invitation</th><th>Invitations</th><th>EA</th><th>Next action</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.key} className="border-t border-stone-100">
            <td className="py-2"><input type="checkbox" aria-label={"Select " + r.name} disabled={!r.invitable} checked={selected.has(r.key)}
              onChange={(e) => { const next = new Set(selected); if (e.target.checked) next.add(r.key); else next.delete(r.key); setSelected(next); }} /></td>
            <td className="font-semibold">{r.name}</td><td>{r.campus}</td><td className="break-all">{r.email}</td>
            <td>{r.booking === "active" ? "Booked" : r.booking === "completed" ? "Completed" : r.interviewStatus ?? "—"}{r.interviewDate ? " · " + fmt(r.interviewDate) : ""}</td>
            <td>{fmt(r.lastInvitationAt)}</td><td>{r.invitationsSent}</td><td>{r.eaOwner ?? "—"}</td>
            <td className={r.invitable ? "text-green-800" : "text-stone-600"}>{r.nextAction}</td></tr>)}
            {!rows.length && <tr><td colSpan={9} className="py-4 text-stone-500">No applicants in this view.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>}
  </section>;
}
