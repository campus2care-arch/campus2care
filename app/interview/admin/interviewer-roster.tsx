"use client";
import { useCallback, useEffect, useMemo, useState } from "react";

type Campus = "BU" | "BC";
type Row = { id: string; name: string; email: string; campuses: Campus[]; teamRole: "lead" | "shadow"; active: boolean;
  weeklyCapacity: number; leadId: string | null; leadName: string | null; invitedAt: string | null;
  weekStatus: "not_submitted" | "confirmed" | "unavailable" | "pending"; confirmedAt: string | null;
  approvalSource: "ea" | "founder" | null; slotCount: number };

const SIGNUP = "https://www.campus2care.org/interview/staff/availability";
const STATUS: Record<Row["weekStatus"], string> = {
  confirmed: "Submitted", unavailable: "Unavailable this week", pending: "Not submitted", not_submitted: "Not submitted",
};

function mondays(): string[] {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date());
  const today = new Date(parts + "T12:00:00Z");
  today.setUTCDate(today.getUTCDate() - (today.getUTCDay() + 6) % 7);
  return [0, 1, 2, 3, 4].map((w) => { const d = new Date(today); d.setUTCDate(d.getUTCDate() + 7 * w); return d.toISOString().slice(0, 10); });
}
function mailto(emails: string[], subject: string, body: string) {
  return "mailto:?bcc=" + encodeURIComponent(emails.join(",")) + "&subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
}

export default function InterviewerRoster() {
  const weeks = useMemo(() => mondays(), []);
  const [campus, setCampus] = useState<Campus>("BC");
  const [week, setWeek] = useState(weeks[1]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [lines, setLines] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const fetchRoster = useCallback(() =>
    fetch(`/api/interview/admin/staff?week=${week}&campus=${campus}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as { ok?: boolean; roster?: Row[]; error?: string };
        if (!response.ok || !data.ok) throw new Error(data.error ?? "roster_unavailable");
        return data.roster ?? [];
      }), [week, campus]);
  const load = useCallback(async () => {
    try { setRows(await fetchRoster()); setError(""); }
    catch (e) { setRows(null); setError(e instanceof Error ? e.message.replaceAll("_", " ") : "roster unavailable"); }
  }, [fetchRoster]);
  useEffect(() => {
    let live = true;
    fetchRoster().then((roster) => { if (live) { setRows(roster); setError(""); } })
      .catch((e: unknown) => { if (live) { setRows(null); setError(e instanceof Error ? e.message.replaceAll("_", " ") : "roster unavailable"); } });
    return () => { live = false; };
  }, [fetchRoster]);

  async function post(body: object) {
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/interview/admin/staff", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json() as { ok?: boolean; error?: string; saved?: number };
      if (!response.ok || !data.ok) throw new Error(data.error ?? "roster_update_unavailable");
      await load();
      return data;
    } catch (e) { setError(e instanceof Error ? e.message.replaceAll("_", " ") : "update failed"); return null; }
    finally { setBusy(false); }
  }

  const people = rows ?? [];
  const leads = people.filter((r) => r.teamRole === "lead");
  const waiting = people.filter((r) => r.weekStatus === "not_submitted" || r.weekStatus === "pending");
  const notInvited = people.filter((r) => !r.invitedAt);
  const weekLabel = new Date(week + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
  const inviteBody = `Hi,\n\nYou've been added as a Campus2Care ${campus} interviewer. Please sign in with your Campus2Care Google account and enter the hours you can run 20-minute virtual interviews for the week of ${weekLabel}:\n\n${SIGNUP}\n\nChoose the week at the top, add your time windows (Eastern Time), then press "Confirm this week". If you can't interview that week, use "No interviews this week".\n\nThank you,\nAndrew`;
  const reminderBody = `Hi,\n\nA reminder to submit your Campus2Care interview availability for the week of ${weekLabel}:\n\n${SIGNUP}\n\nIf you can't interview that week, please mark yourself unavailable so we can plan around it.\n\nThank you,\nAndrew`;

  return <section className="rounded-2xl border border-black/10 bg-white p-6 shadow-sm">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><p className="text-xs font-black uppercase tracking-widest text-[#b3131b]">Interviewers</p>
        <h2 className="mt-1 text-2xl font-black">Roster and weekly availability</h2></div>
      <div className="flex flex-wrap gap-2">
        <select aria-label="Campus" value={campus} onChange={(e) => setCampus(e.target.value as Campus)} className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-semibold">
          <option value="BC">Boston College</option><option value="BU">Boston University</option></select>
        <select aria-label="Week" value={week} onChange={(e) => setWeek(e.target.value)} className="rounded-lg border border-stone-300 px-3 py-2 text-sm">
          {weeks.map((w) => <option key={w} value={w}>Week of {w}</option>)}</select>
      </div>
    </div>
    {error && <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-900">{error}</p>}
    {message && <p role="status" className="mt-4 rounded-lg bg-green-50 p-3 text-sm text-green-900">{message}</p>}

    <div className="mt-5 grid gap-3 sm:grid-cols-4">
      {[["On roster", people.length], ["Submitted", people.filter((r) => r.weekStatus === "confirmed").length],
        ["Unavailable", people.filter((r) => r.weekStatus === "unavailable").length], ["Not submitted", waiting.length]]
        .map(([label, value]) => <div key={label} className="rounded-xl bg-stone-50 p-3"><p className="text-xs text-stone-500">{label}</p><p className="text-2xl font-black">{rows ? value : "–"}</p></div>)}
    </div>

    <div className="mt-5 flex flex-wrap gap-2 text-sm">
      <button type="button" className="rounded-full border border-stone-300 px-4 py-2 font-semibold" onClick={() => { void navigator.clipboard.writeText(SIGNUP); setMessage("Signup link copied: " + SIGNUP); }}>Copy availability signup link</button>
      <a aria-disabled={!notInvited.length} className={"rounded-full border border-stone-300 px-4 py-2 font-semibold " + (notInvited.length ? "" : "pointer-events-none opacity-40")}
        href={mailto(notInvited.map((r) => r.email), `Campus2Care ${campus} interviewer availability`, inviteBody)}
        onClick={() => { void post({ action: "mark_invited", emails: notInvited.map((r) => r.email) }); }}>
        Email invitations to {notInvited.length} not yet invited</a>
      <a aria-disabled={!waiting.length} className={"rounded-full border border-stone-300 px-4 py-2 font-semibold " + (waiting.length ? "" : "pointer-events-none opacity-40")}
        href={mailto(waiting.map((r) => r.email), `Reminder: Campus2Care interview availability (week of ${weekLabel})`, reminderBody)}>
        Remind {waiting.length} who haven&apos;t submitted</a>
    </div>
    <p className="mt-2 text-xs text-stone-500">Invitation and reminder buttons open a pre-written email in your mail app with everyone in BCC, so you review it before it&apos;s sent.</p>

    <div className="mt-5 overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead className="text-xs uppercase text-stone-500"><tr><th className="py-2">Name</th><th>Role</th><th>Assigned lead</th><th>Status ({weekLabel})</th><th>Slots</th><th>Invited</th><th></th></tr></thead>
        <tbody>{people.map((r) => <tr key={r.id} className="border-t border-stone-100">
          <td className="py-2"><p className="font-semibold">{r.name}</p><p className="text-xs text-stone-500">{r.email}</p></td>
          <td>{r.teamRole === "lead" ? "Lead" : "Shadower"}</td>
          <td>{r.teamRole === "shadow" ? <select aria-label={"Lead for " + r.name} disabled={busy} value={r.leadId ?? ""} className="rounded border border-stone-300 px-2 py-1"
            onChange={(e) => { const lead = leads.find((l) => l.id === e.target.value);
              void post({ action: "update", person: { name: r.name, email: r.email, campus, teamRole: "shadow", leadEmail: lead?.email ?? null } }); }}>
            <option value="">Unassigned</option>{leads.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select> : "—"}</td>
          <td><span className={r.weekStatus === "confirmed" ? "text-green-800" : r.weekStatus === "unavailable" ? "text-stone-600" : "text-amber-800"}>{STATUS[r.weekStatus]}</span>
            {r.approvalSource === "founder" && <span className="ml-1 text-xs text-stone-500">(founder-set)</span>}</td>
          <td>{r.slotCount}</td>
          <td className="text-xs">{r.invitedAt ? new Date(r.invitedAt).toLocaleDateString() : "—"}</td>
          <td className="whitespace-nowrap text-right">
            <a className="mr-3 underline" href={"/interview/staff/availability?as=" + encodeURIComponent(r.email)}>Edit hours</a>
            <button type="button" disabled={busy} className="text-red-800 underline" onClick={() => { if (window.confirm("Remove " + r.name + " from the roster? Their history is kept.")) void post({ action: "remove", email: r.email }); }}>Remove</button>
          </td></tr>)}
          {rows && !people.length && <tr><td colSpan={7} className="py-4 text-stone-500">No {campus} interviewers yet. Add them below.</td></tr>}
        </tbody>
      </table>
    </div>

    <div className="mt-6 rounded-xl border border-stone-200 bg-stone-50 p-4">
      <h3 className="font-black">Add {campus} interviewers</h3>
      <p className="mt-1 text-sm text-stone-600">One person per line: <code>Name, email, lead or shadow, lead&apos;s email (shadowers only)</code>. Emails must be Campus2Care Google accounts (@campus2care.org). Re-adding someone updates them.</p>
      <textarea value={lines} onChange={(e) => setLines(e.target.value)} rows={5} disabled={busy}
        placeholder={"Jane Doe, jane.doe@campus2care.org, lead\nSam Lee, sam.lee@campus2care.org, shadow, jane.doe@campus2care.org"}
        className="mt-3 w-full rounded-lg border border-stone-300 p-3 font-mono text-sm" />
      <button type="button" disabled={busy || !lines.trim()} className="mt-2 rounded-full bg-[#b3131b] px-5 py-2 text-sm font-bold text-white disabled:opacity-40"
        onClick={async () => { const done = await post({ action: "add", campus, lines }); if (done) { setLines(""); setMessage(`Saved ${done.saved} ${campus} interviewer(s). They can sign in at ${SIGNUP}`); } }}>
        Add to {campus} roster</button>
    </div>
  </section>;
}
