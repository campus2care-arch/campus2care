/** Keep the scrubbed invitation URL usable on refresh, only in this browser tab. */
export function interviewSessionToken(search: string, hash: string, storage: Pick<Storage, "getItem" | "setItem"> | null, mode: string) {
  const incoming = new URLSearchParams(hash.replace(/^#/, "")).get("token") ?? new URLSearchParams(search).get("token");
  const key = "c2c_interview_token:" + mode;
  try {
    if (incoming !== null) storage?.setItem(key, incoming);
    return incoming ?? storage?.getItem(key) ?? "";
  } catch { return incoming ?? ""; }
}
