import { after } from "next/server";
import { productionRealEnabled } from "./interview-production-launch";
import { processProductionCanaryOutbox } from "./interview-production-worker";

/** After a live booking change, process its Calendar/Meet, confirmation email and
 * Notion jobs right away instead of waiting for the hourly scheduler. The worker's
 * own leases and idempotency keys make overlap with the scheduler safe. */
export function processLiveBookingJobsSoon(): void {
  if (!productionRealEnabled()) return;
  after(async () => {
    try { await processProductionCanaryOutbox(3); } catch { /* the hourly scheduler retries */ }
  });
}
