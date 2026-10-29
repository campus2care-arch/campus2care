/** Public interview booking remains synthetic-only until a separate production service is reviewed. */
export function interviewPublicMode(env: Pick<NodeJS.ProcessEnv, 'VERCEL_ENV' | 'INTERVIEW_BOOKING_ENABLED'> = process.env): 'synthetic-preview' | 'not-open' {
  return env.VERCEL_ENV === 'preview' && env.INTERVIEW_BOOKING_ENABLED === 'true' ? 'synthetic-preview' : 'not-open';
}
