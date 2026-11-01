import { cookies } from "next/headers";
import InterviewReadinessDashboard from "./readiness-dashboard";
import FounderApplicantCampaigns from "./founder-applicant-campaigns";
import InterviewProviderSetup from "./provider-setup";
import ProviderBookingCanary from "./provider-booking-canary";
import InterviewerRoster from "./interviewer-roster";
import FounderConsole from "./founder-console";
import { providerAuthorizationEnabled } from "../../../lib/interview-provider-store";
import { SESSION_COOKIE, validateSession } from "../../../lib/interview-auth";
import { interviewStaffEnabled } from "../../../lib/interview-staff-db";
import { productionRealEnabled } from "../../../lib/interview-production-launch";

export const dynamic = "force-dynamic";

export default async function InterviewAdminPage() {
  const session = validateSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (session?.role !== "admin") {
    return <main className="mx-auto max-w-xl p-8">
      <h1 className="text-2xl font-black">Campus2Care interview dashboard</h1>
      <p className="mt-3 text-stone-700">Sign in with the founder&apos;s Campus2Care Google account to manage interviews.</p>
      <a className="mt-5 inline-flex rounded-full bg-[#b3131b] px-5 py-3 font-bold text-white" href="/api/interview/auth/start?returnTo=/interview/admin">Sign in</a>
    </main>;
  }
  if (process.env.VERCEL_ENV === "production") {
    return <main className="mx-auto max-w-6xl space-y-8 px-4 py-8 sm:px-8">
      <header><p className="text-xs font-black uppercase tracking-widest text-[#b3131b]">Campus2Care</p>
        <h1 className="text-3xl font-black">Interview dashboard</h1></header>
      {interviewStaffEnabled() && <FounderConsole />}
      {interviewStaffEnabled() ? <InterviewerRoster /> :
        <section className="rounded-2xl border border-amber-300 bg-amber-50 p-6">Interviewer management is switched off (INTERVIEW_PRODUCTION_STAFF_ENABLED).</section>}
      <FounderApplicantCampaigns enabled={process.env.INTERVIEW_PRODUCTION_APPLICANT_REVIEW_ENABLED === "true"} />
      <details className="rounded-2xl border border-stone-200 bg-white p-4">
        <summary className="cursor-pointer font-bold">System diagnostics</summary>
        {providerAuthorizationEnabled() ? <>
          <InterviewProviderSetup showTestEmails={process.env.INTERVIEW_PRODUCTION_VERIFICATION_CANARY_ENABLED === "true"} />
          <ProviderBookingCanary enabled={productionRealEnabled() || process.env.INTERVIEW_BOOKING_PROVIDER_CANARY_ENABLED === "true"} />
        </> : <p className="p-4">Provider setup is unavailable.</p>}
      </details>
    </main>;
  }
  return <>
    <div className="mx-auto max-w-6xl px-4 pt-8 sm:px-8"><InterviewerRoster /></div>
    <InterviewReadinessDashboard />
    <div className="mx-auto max-w-6xl px-4 pb-12 sm:px-8"><FounderApplicantCampaigns previewOnly /></div>
  </>;
}
