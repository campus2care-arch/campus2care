/**
 * Campus2Care's external heartbeat for the production interview scheduler.
 * No credentials or recipient data live in this repository.
 *
 * SCHEDULER_SECRET is a Cloudflare secret that must equal Vercel's
 * INTERVIEW_PRODUCTION_SCHEDULER_SECRET. Logs never include the secret,
 * response bodies or recipient data.
 */
const ENDPOINT = "https://www.campus2care.org/api/interview/production/scheduler";
const TIME_ZONE = "America/New_York";
// Cloudflare cron is UTC. The Sunday run is registered at both possible UTC
// times (13:45 during EDT, 14:45 during EST) and only the one that is 09:45 in
// New York actually calls the scheduler, so it never shifts or runs twice.
const SUNDAY_CRONS = new Set(["45 13 * * SUN", "45 14 * * SUN"]);
const SUNDAY_LOCAL_TIME = "09:45";

function newYorkTime(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { weekday: parts.weekday, time: parts.hour + ":" + parts.minute };
}

function log(level, event, fields) {
  console[level](JSON.stringify({ c2c: event, ...fields }));
}

export function shouldRun(cron, scheduledTime) {
  if (!SUNDAY_CRONS.has(cron)) return true;
  const local = newYorkTime(scheduledTime);
  return local.weekday === "Sun" && local.time === SUNDAY_LOCAL_TIME;
}

export async function callScheduler(secret, cron, fetchImpl = fetch) {
  const started = Date.now();
  let response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { Authorization: "Bearer " + secret },
      // Cloudflare rejects redirect:"error". "manual" never follows a redirect,
      // so the bearer token is only ever sent to the fixed production host.
      redirect: "manual",
      signal: AbortSignal.timeout(45000),
    });
  } catch (error) {
    const kind = error && error.name === "TimeoutError" ? "timeout" : "network_error";
    log("error", "scheduler_call_failed", { cron, kind });
    throw new Error("c2c_production_scheduler_" + kind);
  }
  const ms = Date.now() - started;
  if (response.status >= 300 && response.status < 400) {
    let target = "unknown";
    try { target = new URL(response.headers.get("location") || "", ENDPOINT).host; } catch { /* keep unknown */ }
    log("error", "scheduler_redirect_refused", { cron, status: response.status, target, ms });
    throw new Error("c2c_production_scheduler_redirect_" + response.status);
  }
  if (response.status === 401 || response.status === 403) {
    log("error", "scheduler_auth_rejected", { cron, status: response.status, ms,
      hint: "SCHEDULER_SECRET must equal Vercel INTERVIEW_PRODUCTION_SCHEDULER_SECRET" });
    throw new Error("c2c_production_scheduler_auth_" + response.status);
  }
  if (!response.ok) {
    log("error", "scheduler_http_error", { cron, status: response.status, ms });
    throw new Error("c2c_production_scheduler_http_" + response.status);
  }
  let outcome = "unknown";
  try { const body = await response.json(); outcome = typeof body.outcome === "string" ? body.outcome : outcome; } catch { /* non-JSON */ }
  log("log", "scheduler_ok", { cron, status: response.status, outcome, ms });
  return { status: response.status, outcome };
}

export default {
  async scheduled(event, env, ctx) {
    if (env.INTERVIEW_CRON_ENABLED !== "true") {
      log("log", "cron_disabled", { cron: event.cron });
      return;
    }
    if (!shouldRun(event.cron, event.scheduledTime)) {
      log("log", "sunday_trigger_skipped_other_offset", { cron: event.cron });
      return;
    }
    if (typeof env.SCHEDULER_SECRET !== "string" || env.SCHEDULER_SECRET.length < 40) {
      log("error", "scheduler_secret_missing", { cron: event.cron });
      throw new Error("c2c_cron_secret_not_configured");
    }
    // The server evaluates all Eastern-Time campaign windows; database run keys
    // make repeated or overlapping calls idempotent.
    ctx.waitUntil(callScheduler(env.SCHEDULER_SECRET, event.cron));
  },
};
