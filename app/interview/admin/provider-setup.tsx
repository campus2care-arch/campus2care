"use client";

import { useEffect, useState } from "react";

type Status = {
  checks: { provider: string; account: string; verified: boolean }[];
  checkedAt: string;
};

async function readStatus(): Promise<Status | null> {
  const response = await fetch("/api/interview/providers/google/status", { cache: "no-store" });
  if (response.status === 403) return null;
  if (!response.ok) throw new Error("provider_status_unavailable");
  return response.json();
}

export default function InterviewProviderSetup() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(true);
  const [signInRequired, setSignInRequired] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    void readStatus().then(result => {
      if (live) { setStatus(result); setSignInRequired(result === null); }
    }).catch(() => {
      if (live) setError("Could not check connections. Try again.");
    }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, []);

  async function refresh() {
    setBusy(true); setError("");
    try {
      const result = await readStatus();
      setStatus(result); setSignInRequired(result === null);
    } catch { setError("Could not check connections. Try again."); }
    finally { setBusy(false); }
  }

  return <main className="min-h-screen bg-stone-50 px-5 py-12 text-stone-900">
    <section className="mx-auto max-w-2xl rounded-2xl border border-black/10 bg-white p-7">
      <p className="text-xs font-bold uppercase tracking-wide text-stone-500">Campus2Care · Leadership only</p>
      <h1 className="mt-3 text-3xl font-black">Interview service connections</h1>
      <p className="mt-3 text-sm text-stone-600">Connect the interview Calendar and volunteer support Gmail accounts. Checking connections verifies account identity and token refresh without creating appointments or sending messages.</p>
      {busy && <p role="status" className="mt-5">Checking connections…</p>}
      {signInRequired && <p className="mt-5"><a className="font-semibold underline" href="/api/interview/auth/start?returnTo=%2Finterview%2Fadmin">Sign in as leadership</a></p>}
      {status && <>
        <ul className="mt-6 space-y-3">
          {status.checks.map(check => <li key={check.provider}>
            <strong>{check.account}</strong>: {check.verified ? "Verified" : "Connection required"}
          </li>)}
        </ul>
        <div className="mt-6 flex flex-wrap gap-3">
          <a className="rounded-full border border-black/15 px-4 py-2 text-sm font-semibold" href="/api/interview/providers/google/start?provider=calendar">Connect interviews@ Calendar</a>
          <a className="rounded-full border border-black/15 px-4 py-2 text-sm font-semibold" href="/api/interview/providers/google/start?provider=gmail">Connect contact@ Gmail</a>
        </div>
        <p className="mt-4 text-xs text-stone-500">Last checked: {new Date(status.checkedAt).toLocaleString()}</p>
      </>}
      {error && <p role="alert" className="mt-5 text-red-800">{error}</p>}
      <button disabled={busy} onClick={() => void refresh()} className="mt-5 rounded-full border border-black/15 px-4 py-2 text-sm font-semibold disabled:opacity-50">Check connections</button>
    </section>
  </main>;
}
