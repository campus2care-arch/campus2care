import InterviewReadinessDashboard from "./readiness-dashboard";
import InterviewProviderSetup from "./provider-setup";
import { providerAuthorizationEnabled } from "../../../lib/interview-provider-store";

export const dynamic = "force-dynamic";

export default function InterviewAdminPage() {
  if (process.env.VERCEL_ENV === "production") {
    return providerAuthorizationEnabled()
      ? <InterviewProviderSetup showTestEmails={process.env.INTERVIEW_PRODUCTION_VERIFICATION_CANARY_ENABLED === "true"} />
      : <main className="mx-auto max-w-2xl p-8"><h1>Interview setup is unavailable</h1></main>;
  }
  return <InterviewReadinessDashboard />;
}
