import { createHash, timingSafeEqual } from "node:crypto";
import { assertProductionCanaryIdentity, productionCanaryConfig } from "./interview-production-canary";
import type { Campus } from "./interview-notion-contract";

/** The release key is intentionally distinct from the synthetic/canary switches.
 * No public applicant may book until every independently reviewed release gate
 * has been enabled. Neither this module nor the launch UI changes those flags.
 */
type Environment = Record<string, string | undefined>;
export function productionRealEnabled(env: Environment = process.env): boolean {
  if (env.VERCEL_ENV !== "production" || env.INTERVIEW_DATA_ENV !== "production" ||
      env.INTERVIEW_LIVE_APPLICANTS_ENABLED !== "true" ||
      env.INTERVIEW_LIVE_RELEASE_APPROVED !== "true" ||
      env.INTERVIEW_PRODUCTION_CANARY_ENABLED === "true") return false;
  const needed = [
    "INTERVIEW_PRODUCTION_ENABLED", "INTERVIEW_BOOKING_ENABLED",
    "INTERVIEW_PRODUCTION_WORKER_ADAPTER_READY",
    "INTERVIEW_CALENDAR_WRITES_ENABLED", "INTERVIEW_GMAIL_SENDS_ENABLED",
    "INTERVIEW_NOTION_WRITES_ENABLED", "INTERVIEW_OUTBOX_WORKER_ENABLED",
  ];
  return needed.every(key => env[key] === "true");
}
export function productionRealConfig(env: Environment = process.env) {
  if (!productionRealEnabled(env)) throw Error("interview_production_real_disabled");
  const db = env.INTERVIEW_DATABASE_URL ?? "";
  const host = env.INTERVIEW_DATABASE_HOST ?? "";
  let url: URL;
  try { url = new URL(db); } catch { throw Error("interview_production_database_invalid"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname.endsWith(".neon.tech") || url.hostname !== host ||
      !url.username || !url.password || url.pathname.length<2 ||
      url.searchParams.get("sslmode")==="disable" || url.hash) {
    throw Error("interview_production_database_invalid");
  }
  return {mode:"live" as const,databaseUrl:db};
}
export function productionBookingServicesConfig() {
  if (productionRealEnabled()) return productionRealConfig();
  const c=productionCanaryConfig();
  return {mode:"canary" as const,databaseUrl:c.databaseUrl};
}
/** Caller must also verify token-bound persisted identity AND live Notion parent,
 * email, active status and interview eligibility. Not an authorization alone.
 */
export function assertProductionBookingIdentity(campus:Campus,email:string,pageId:string){
  if (productionRealEnabled()) {
    if (!["BU","BC"].includes(campus) ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        !/^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(pageId)) {
      throw Error("interview_production_invalid_identity");
    }
    return {campus,email:email.toLowerCase(),pageId:pageId.replaceAll("-","").toLowerCase()};
  }
  return assertProductionCanaryIdentity(campus,email,pageId);
}
/** Secret used exclusively to authenticate the release scheduler, not an
 * applicant token or provider access token.
 */
export function productionSchedulerAuthorized(header:string|null,env:Environment=process.env){
  if (!productionRealEnabled(env)) return false;
  const secret=env.INTERVIEW_PRODUCTION_SCHEDULER_SECRET??"";
  if(secret.length<40||!header?.startsWith("Bearer "))return false;
  const provided=Buffer.from(header.slice(7));
  const expected=Buffer.from(secret);
  return provided.length===expected.length && timingSafeEqual(provided,expected);
}
export function productionSchedulerRunKey(instant:Date,kind:string){
  if (!Number.isFinite(instant.getTime()) || !/^[a-z_]{3,60}$/.test(kind))throw Error("invalid_scheduler_key");
  return createHash("sha256").update(kind+":"+instant.toISOString().slice(0,16)).digest("hex");
}
