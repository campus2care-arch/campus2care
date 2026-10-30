import InterviewReadinessDashboard from "./readiness-dashboard";
import FounderApplicantCampaigns from "./founder-applicant-campaigns";
import InterviewProviderSetup from "./provider-setup";
import ProviderBookingCanary from "./provider-booking-canary";
import { providerAuthorizationEnabled } from "../../../lib/interview-provider-store";

export const dynamic = "force-dynamic";

export default function InterviewAdminPage() {
  if (process.env.VERCEL_ENV === "production") {
    return providerAuthorizationEnabled()
      ? <>
          <InterviewProviderSetup showTestEmails={process.env.INTERVIEW_PRODUCTION_VERIFICATION_CANARY_ENABLED === "true"} />
          <ProviderBookingCanary enabled={process.env.INTERVIEW_BOOKING_PROVIDER_CANARY_ENABLED === "true"} />
          <FounderApplicantCampaigns enabled={process.env.INTERVIEW_PRODUCTION_APPLICANT_REVIEW_ENABLED === "true"} />
        </>
      : <main className="mx-auto max-w-2xl p-8"><h1>Interview setup is unavailable</h1></main>;
  }
  return <><InterviewReadinessDashboard /><div className="mx-auto max-w-6xl px-4 pb-12 sm:px-8"><FounderApplicantCampaigns previewOnly /></div></>;
}
