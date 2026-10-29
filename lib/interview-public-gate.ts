/** Public interview booking remains synthetic-only until a separate production service is reviewed. */
export function interviewPublicMode(env: { VERCEL_ENV?: string; INTERVIEW_BOOKING_ENABLED?: string } = process.env): 'synthetic-preview' | 'not-open' {
  return env.VERCEL_ENV === 'preview' && env.INTERVIEW_BOOKING_ENABLED === 'true' ? 'synthetic-preview' : 'not-open';
}
