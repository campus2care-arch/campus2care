/** Public booking is available only for synthetic applicants in enabled previews. */
export function interviewPublicMode(
  env?: { VERCEL_ENV?: string; INTERVIEW_BOOKING_ENABLED?: string },
): "synthetic-preview" | "not-open" {
  const runtime = env ?? {
    VERCEL_ENV: process.env["VERCEL_ENV"],
    INTERVIEW_BOOKING_ENABLED: process.env["INTERVIEW_BOOKING_ENABLED"],
  };
  return runtime.VERCEL_ENV === "preview" && runtime.INTERVIEW_BOOKING_ENABLED === "true"
    ? "synthetic-preview" : "not-open";
}
