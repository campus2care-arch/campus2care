/**
 * Campus2Care's external hourly heartbeat for Vercel Hobby.
 * No credentials or recipient data live in this repository.
 *
 * Deploy separately with Cloudflare Workers and set SCHEDULER_SECRET with
 * Wrangler's secret store. The matching server-side secret is configured
 * separately in the Campus2Care Vercel production environment.
 */
export default {
  async scheduled(_event, env, ctx) {
    if (env.INTERVIEW_CRON_ENABLED !== "true") return;
    const endpoint = "https://www.campus2care.org/api/interview/production/scheduler";
    if (typeof env.SCHEDULER_SECRET !== "string" || env.SCHEDULER_SECRET.length < 40) {
      throw new Error("c2c_cron_secret_not_configured");
    }
    // Every hour handles DST transitions automatically on the server using
    // America/New_York. Database run keys make repeat calls idempotent.
    ctx.waitUntil((async () => {
      const result = await fetch(endpoint, {
        method:"POST",
        headers:{Authorization:"Bearer "+env.SCHEDULER_SECRET},
        redirect:"error",
        signal:AbortSignal.timeout(45000),
      });
      if (!result.ok) {
        // Never include response bodies, applicant data or bearer tokens in logs.
        throw new Error("c2c_production_scheduler_http_"+result.status);
      }
    })());
  },
};
