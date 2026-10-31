import postgres, { type Sql } from "postgres";
import { interviewDatabase } from "./interview-db";

type Settings = Record<string, string | undefined>;
let production: Sql | undefined;

/** Authorization can be completed before any booking or messaging switch is enabled. */
export function providerAuthorizationEnabled(env: Settings = process.env): boolean {
  return env.VERCEL_ENV === "preview" || (env.VERCEL_ENV === "production" &&
    env.INTERVIEW_DATA_ENV === "production" && env.INTERVIEW_PROVIDER_AUTH_ENABLED === "true");
}
export function productionProviderConnection(env: Settings = process.env): string {
  if (env.VERCEL_ENV !== "production" || !providerAuthorizationEnabled(env)) {
    throw new Error("production_provider_authorization_disabled");
  }
  let url: URL;
  try { url = new URL(env.INTERVIEW_DATABASE_URL ?? ""); }
  catch { throw new Error("production_provider_database_invalid"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname.endsWith(".neon.tech") || url.hostname !== env.INTERVIEW_DATABASE_HOST ||
      !url.username || !url.password || url.pathname.length < 2 || url.hash ||
      url.searchParams.get("sslmode") === "disable") throw new Error("production_provider_database_invalid");
  return url.toString();
}
/** Only the credential table is accessed by callers; preview always keeps its own DB. */
export function providerCredentialDatabase(): Sql {
  if (process.env.VERCEL_ENV === "preview") return interviewDatabase();
  const connection = productionProviderConnection();
  production ??= postgres(connection, {max: 1, ssl: "require", prepare: false,
    connect_timeout: 5, idle_timeout: 5});
  return production;
}
