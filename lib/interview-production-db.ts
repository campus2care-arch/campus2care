import postgres, { type Sql } from "postgres";
import { productionRealEnabled, productionRealConfig, assertProductionBookingIdentity } from "./interview-production-launch";

// Production-real mode is a separate explicit release. Canary-only routes
// retain their original canary guards and cannot be widened by this adapter.
const productionServiceConfig = () => productionRealEnabled()
  ? productionRealConfig() : productionCanaryConfig();

import { productionCanaryConfig } from "./interview-production-canary";

let productionClient: Sql | undefined;

/** Separate from staging interviewDatabase(). Entirely dormant unless the
 * canary is enabled, live adapters are deployed, and all providers are ready.
 */
export function productionInterviewDatabase(): Sql {
  const config = productionServiceConfig();
  if (!productionClient) {
    productionClient = postgres(config.databaseUrl, {
      max: 2, connect_timeout: 8, idle_timeout: 15,
      ssl: "require", prepare: false, onnotice: () => undefined,
      connection: { application_name: "campus2care-interview-canary" },
    });
  }
  return productionClient;
}
