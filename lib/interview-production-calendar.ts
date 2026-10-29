import type { InterviewParticipant } from "./interview-teams";
import { productionCanaryConfig } from "./interview-production-canary";

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
  productionCanaryConfig();
  if (process.env["INTERVIEW_PRODUCTION_CALENDAR_READS_ENABLED"] !== "true") {
    throw new ProductionCalendarCheckError("production_calendar_reads_disabled");
  }
  const refresh = process.env["INTERVIEW_PRODUCTION_CALENDAR_REFRESH_TOKEN"] ?? "";
  const clientId = process.env["INTERVIEW_GOOGLE_CLIENT_ID"] ?? "";
  const clientSecret = process.env["INTERVIEW_GOOGLE_CLIENT_SECRET"] ?? "";
  if (refresh.length < 20 || clientId.length < 10 || clientSecret.length < 10) {
    throw new ProductionCalendarCheckError("production_calendar_oauth_missing");
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
  const tokenResponse = await fetchChecked(transport,"https://oauth2.googleapis.com/token",{
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({
      client_id:clientId,client_secret:clientSecret,refresh_token:refresh,grant_type:"refresh_token",
    }),
  });
  if (!tokenResponse.ok) throw new ProductionCalendarCheckError("production_calendar_token_unavailable");
  const tokenPayload=await tokenResponse.json() as { access_token?: unknown };
  if(typeof tokenPayload.access_token!=="string" || tokenPayload.access_token.length<20) {
    throw new ProductionCalendarCheckError("production_calendar_token_invalid");
  }
  const auth={Authorization:"Bearer "+tokenPayload.access_token};
  const account=await fetchChecked(transport,"https://openidconnect.googleapis.com/v1/userinfo",{headers:auth});
  if (!account.ok) throw new ProductionCalendarCheckError("production_calendar_identity_unavailable");
  const identity=await account.json() as {email?:unknown;email_verified?:unknown};
  if (identity.email !== "interviews@campus2care.org" || identity.email_verified !== true) {
    throw new ProductionCalendarCheckError("production_calendar_wrong_account");
  }
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
