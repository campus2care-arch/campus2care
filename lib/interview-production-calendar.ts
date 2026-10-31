import { productionGoogleAccessToken } from "./interview-production-providers";

import type { InterviewParticipant } from "./interview-teams";
import { productionCanaryConfig } from "./interview-production-canary";

import { productionRealEnabled, productionRealConfig, assertProductionBookingIdentity } from "./interview-production-launch";

// Production-real mode is a separate explicit release. Canary-only routes
// retain their original canary guards and cannot be widened by this adapter.
const productionServiceConfig = () => productionRealEnabled()
  ? productionRealConfig() : productionCanaryConfig();


export class ProductionCalendarCheckError extends Error {
  constructor(public readonly code: string) { super(code); }
}
async function fetchChecked(transport: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try { return await transport(url,{...init,cache:"no-store",signal:AbortSignal.timeout(8000)}); }
  catch { throw new ProductionCalendarCheckError("production_calendar_unreachable"); }
}
export async function checkProductionCanaryCalendars(
  participants: InterviewParticipant[],
  startsAt: string,
  endsAt: string,
  transport: typeof fetch = fetch,
): Promise<void> {
  productionServiceConfig();
  if (process.env["INTERVIEW_PRODUCTION_CALENDAR_READS_ENABLED"] !== "true") {
    throw new ProductionCalendarCheckError("production_calendar_reads_disabled");
  }
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) ||
      new Date(start).toISOString() !== startsAt ||
      new Date(end).toISOString() !== endsAt ||
      end - start !== 20 * 60000 || !Array.isArray(participants) ||
      participants.length < 2 || participants.length > 12 ||
      participants.filter(p=>p.role==="lead").length !== 1 ||
      participants.some(p=>!p.available || !/^[a-z0-9._%+-]+@campus2care\.org$/.test(p.email))) {
    throw new ProductionCalendarCheckError("production_calendar_input_invalid");
  }
  const accessToken = await productionGoogleAccessToken("calendar", transport);
  const auth = {Authorization: "Bearer " + accessToken};
  const calendars=[...new Set(participants.map(p=>p.email))];
  const response=await fetchChecked(transport,"https://www.googleapis.com/calendar/v3/freeBusy",{
    method:"POST",headers:{...auth,"Content-Type":"application/json"},
    body:JSON.stringify({timeMin:startsAt,timeMax:endsAt,timeZone:"America/New_York",
      items:calendars.map(id=>({id}))}),
  });
  if (!response.ok) throw new ProductionCalendarCheckError("production_calendar_freebusy_unavailable");
  const body=await response.json() as {calendars?:Record<string,{errors?:unknown;busy?:Array<{start?:string;end?:string}>}>};
  if (!body.calendars) throw new ProductionCalendarCheckError("production_calendar_freebusy_invalid");
  for(const email of calendars) {
    const row=body.calendars[email];
    if (!row || (Array.isArray(row.errors)&&row.errors.length>0) ||
        !Array.isArray(row.busy)) {
      throw new ProductionCalendarCheckError("production_calendar_participant_unavailable");
    }
    for (const interval of row.busy) {
      const from=Date.parse(interval.start??""),to=Date.parse(interval.end??"");
      if (!Number.isFinite(from)||!Number.isFinite(to)||from>=to) {
        throw new ProductionCalendarCheckError("production_calendar_freebusy_invalid");
      }
      if(start<to&&from<end) {
        throw new ProductionCalendarCheckError("production_calendar_participant_busy");
      }
    }
  }
}
