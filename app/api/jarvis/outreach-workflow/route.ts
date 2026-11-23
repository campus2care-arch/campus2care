export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const headers = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self' https://www.campus2care.org; frame-ancestors https://app.notion.com https://www.notion.so https://*.notion.so https://*.notion.site",
};

const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Campus2Care Outreach Workflow</title>
<style>
:root{color-scheme:light;--red:#ba2540;--red-dark:#941932;--ink:#292b30;--muted:#68717d}
*{box-sizing:border-box}html,body{margin:0;padding:0;background:transparent;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:var(--ink)}
.wrap{max-width:1060px;margin:0 auto;background:linear-gradient(118deg,#fff8f9 0%,#fff 76%);border:1px solid #f1d9de;border-radius:18px;padding:23px 26px 21px;box-shadow:0 5px 20px rgba(126,22,44,.035)}
.head{display:flex;align-items:center;gap:12px;margin-bottom:17px}.logo{flex:none;width:38px;height:38px;border-radius:12px;background:#fbe7e9;display:grid;place-items:center;color:var(--red);font-weight:900;font-size:22px}.titles{flex:1}.eyebrow{font-size:11px;color:var(--red-dark);font-weight:800;letter-spacing:1.1px;text-transform:uppercase;margin-bottom:3px}.headline{font-size:20px;font-weight:800;line-height:1.3;letter-spacing:-.3px}
.steps{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;list-style:none;padding:0;margin:0}
.step{position:relative;min-height:147px;background:#fff;border:1px solid #e9e4e5;border-radius:13px;padding:15px 14px;animation:focusStep 12s linear infinite;box-shadow:0 2px 8px rgba(33,26,30,.02)}
.step:nth-child(2){animation-delay:-9s}.step:nth-child(3){animation-delay:-6s}.step:nth-child(4){animation-delay:-3s}
.num{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:50%;background:#fce9ed;color:#a9233f;font-weight:800;font-size:13px;margin-bottom:10px}
.label{font-size:15px;font-weight:800;margin-bottom:6px}.desc{font-size:13px;line-height:1.45;color:#5d6570}.arrow{position:absolute;top:50%;right:-12px;background:#fff;border:1px solid #f0dde2;border-radius:50%;height:21px;width:21px;display:grid;place-items:center;font-weight:900;color:var(--red);z-index:2;font-size:13px}
.progress{height:4px;border-radius:5px;background:#f7e5e9;overflow:hidden;margin-top:17px}.fill{height:100%;width:25%;background:linear-gradient(90deg,#f2b7c3,var(--red));border-radius:5px;animation:grow 12s linear infinite}
.foot{margin-top:14px;font-size:12px;color:#66707a;line-height:1.5}.foot strong{color:#a3223d}
@keyframes focusStep{0%,21%{background:#fff3f5;border-color:#da8999;box-shadow:0 0 0 2px rgba(187,40,65,.09)}25%,100%{background:#fff;border-color:#e9e4e5;box-shadow:0 2px 8px rgba(33,26,30,.02)}}
@keyframes grow{0%{width:0}100%{width:100%}}
@media(max-width:700px){.wrap{padding:18px 16px}.headline{font-size:17px}.steps{grid-template-columns:repeat(2,minmax(0,1fr))}.step{min-height:122px}.step:nth-child(2) .arrow{display:none}.arrow{right:-11px}}
@media(max-width:400px){.steps{grid-template-columns:1fr}.step{min-height:auto}.arrow{display:none}}
@media(prefers-reduced-motion:reduce){.step,.fill{animation:none}.fill{width:100%}}
</style></head><body>
<section class="wrap" aria-label="Four-step hospital outreach correspondence workflow">
<div class="head"><div class="logo" aria-hidden="true">♥</div><div class="titles"><div class="eyebrow">Campus2Care · Weekly outreach</div><div class="headline">Review last week's follow-ups before sending anything new</div></div></div>
<ol class="steps">
<li class="step"><div class="num">01</div><div class="label">Review last week</div><div class="desc">Check unresolved replies and next steps from the previous correspondence log.</div><div class="arrow" aria-hidden="true">›</div></li>
<li class="step"><div class="num">02</div><div class="label">Open partner record</div><div class="desc">Check BWH, BMC, Tufts or COMP and confirm the planned outreach.</div><div class="arrow" aria-hidden="true">›</div></li>
<li class="step"><div class="num">03</div><div class="label">Record the contact</div><div class="desc">After sending or meeting, add the real date, contact, subject and channel.</div><div class="arrow" aria-hidden="true">›</div></li>
<li class="step"><div class="num">04</div><div class="label">Paste &amp; update</div><div class="desc">Paste the actual exchange. Update Last Contact and the next action.</div></li>
</ol>
<div class="progress" aria-hidden="true"><div class="fill"></div></div>
<div class="foot"><strong>Reminder:</strong> Copy and paste the exact email or text you sent, including the subject line and any replies, into the communication log.</div>
</section></body></html>`;

export function GET(): Response {
  return new Response(html, {
    status: 200,
    headers,
  });
}
