"use client";

import { useEffect, useState } from "react";

type Status = {
  checks: { provider: string; account: string; verified: boolean; errorCode?: string }[];
  notionChecks: { campus: string; readable: boolean; schemaReady: boolean; errorCode: string | null }[];
  checkedAt: string;
};

async function readStatus(): Promise<Status | null> {
  const [response, notion] = await Promise.all([
    fetch("/api/interview/providers/google/status", { cache: "no-store" }),
    fetch("/api/interview/providers/notion/status", { cache: "no-store" }),
  ]);
  if (response.status === 403) return null;
  if (!response.ok || !notion.ok) throw new Error("provider_status_unavailable");
  const [googleBody, notionBody] = await Promise.all([response.json(), notion.json()]);
  return { ...googleBody, notionChecks: notionBody.checks };
}

type CanaryCampus = "BU" | "BC";
type CanaryResult = { token: string; status: string };

export default function InterviewProviderSetup({ showTestEmails = false }: { showTestEmails?: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(true);
  const [signInRequired, setSignInRequired] = useState(false);
  const [error, setError] = useState("");
  const [testState, setTestState] = useState<Partial<Record<CanaryCampus, CanaryResult>>>({});
  const [codes, setCodes] = useState<Partial<Record<CanaryCampus, string>>>({});
  const [attempted, setAttempted] = useState<Partial<Record<CanaryCampus, boolean>>>({});
  const [verifying, setVerifying] = useState<CanaryCampus | null>(null);

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

  async function sendCanary(campus: CanaryCampus) {
    if (attempted[campus]) return;
    setAttempted(current => ({ ...current, [campus]: true }));
    setTestState(current => ({ ...current, [campus]: { token: "", status: "Requesting approved test email…" } }));
    try {
      const response = await fetch("/api/interview/admin/production-canary-email", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campus }), cache: "no-store",
      });
      const result = await response.json() as { invitationToken?: string; error?: string };
      if (!response.ok || typeof result.invitationToken !== "string") {
        setTestState(current => ({ ...current, [campus]: { token: "", status: "Not sent or delivery uncertain: " + (result.error ?? "unavailable") + ". Do not retry." } }));
        return;
      }
      setTestState(current => ({ ...current, [campus]: { token: result.invitationToken!, status: "Gmail accepted one test message. Enter the six-digit code from the test inbox." } }));
    } catch {
      setTestState(current => ({ ...current, [campus]: { token: "", status: "Request outcome uncertain. Do not retry; check the server records." } }));
    }
  }

  async function verifyCanary(campus: CanaryCampus) {
    const token = testState[campus]?.token;
    const code = codes[campus] ?? "";
    if (!token || !/^\d{6}$/.test(code)) return;
    setVerifying(campus);
    try {
      const response = await fetch("/api/interview/production/verify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", invitationToken: token, code }),
        cache: "no-store",
      });
      const result = await response.json() as { verified?: boolean; error?: string };
      setTestState(current => ({ ...current, [campus]: {
        token: result.verified ? "" : token,
        status: result.verified ? "Verified: test-email possession confirmed." : "Code rejected: " + (result.error ?? "unavailable"),
      } }));
      if (result.verified) setCodes(current => ({ ...current, [campus]: "" }));
    } catch {
      setTestState(current => ({ ...current, [campus]: { token, status: "Verification request failed. Check the response before retrying." } }));
    } finally { setVerifying(null); }
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
            {!check.verified && check.errorCode && <span className="block text-xs text-stone-500">{check.errorCode}</span>}
          </li>)}
        </ul>
        <h2 className="mt-6 text-lg font-bold">Volunteer pipeline access</h2>
        <ul className="mt-3 space-y-3">
          {status.notionChecks.map(check => <li key={check.campus}>
            <strong>{check.campus} Notion pipeline</strong>: {check.readable && check.schemaReady ? "Read access and interview fields verified" : check.errorCode}
          </li>)}
        </ul>
        <div className="mt-6 flex flex-wrap gap-3">
          <a className="rounded-full border border-black/15 px-4 py-2 text-sm font-semibold" href="/api/interview/providers/google/start?provider=calendar">Connect interviews@ Calendar</a>
          <a className="rounded-full border border-black/15 px-4 py-2 text-sm font-semibold" href="/api/interview/providers/google/start?provider=gmail">Connect contact@ Gmail</a>
        </div>
        <p className="mt-4 text-xs text-stone-500">Last checked: {new Date(status.checkedAt).toLocaleString()}</p>
      </>}
      {showTestEmails && status && <section className="mt-8 border-t border-stone-200 pt-6" aria-label="Controlled email test">
        <h2 className="text-lg font-bold">Approved BU/BC verification test</h2>
        <p className="mt-2 text-sm text-stone-600">Use only the two internal test inbox aliases. This does not invite volunteers or create Calendar events. Each button sends at most one approved test message. Never click twice after an uncertain response.</p>
        {(["BU", "BC"] as const).map(campus => <div key={campus} className="mt-4 rounded-lg border border-stone-200 p-4">
          <p className="text-sm font-semibold">{campus}: contact+interview-canary-{campus.toLowerCase()}@campus2care.org</p>
          <button type="button" disabled={!!attempted[campus]} onClick={() => void sendCanary(campus)} className="mt-3 rounded-lg bg-red-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Send approved {campus} test verification</button>
          {testState[campus] && <p role="status" className="mt-3 text-sm">{testState[campus]?.status}</p>}
          {!!testState[campus]?.token && <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="text-sm" htmlFor={"otp-" + campus}>Email code</label>
            <input id={"otp-" + campus} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={codes[campus] ?? ""} onChange={event => setCodes(current => ({ ...current, [campus]: event.target.value.replace(/[^0-9]/g, "").slice(0,6) }))} className="w-28 rounded border px-3 py-2 text-sm" />
            <button type="button" disabled={verifying === campus || !/^\d{6}$/.test(codes[campus] ?? "")} onClick={() => void verifyCanary(campus)} className="rounded border border-stone-300 px-4 py-2 text-sm font-semibold disabled:opacity-50">Verify</button>
          </div>}
        </div>)}
      </section>}
      {error && <p role="alert" className="mt-5 text-red-800">{error}</p>}
      <button disabled={busy} onClick={() => void refresh()} className="mt-5 rounded-full border border-black/15 px-4 py-2 text-sm font-semibold disabled:opacity-50">Check connections</button>
    </section>
  </main>;
}
