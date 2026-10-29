# Interview provider setup checkpoint, October 29, 2026

The missing Vercel alias was the immediate OAuth blocker. Assigned
`campus2care-interview-provider-setup.vercel.app` to the existing READY setup
deployment `dpl_8kzmDgQ23JMHR4i9z76fGhybyidq` at audited commit
`f9de5ab00f0b74f502d8a727fe2df7fb93a77ad1`. Vercel alias readback and browser
loading succeeded. No production promotion or custom-domain reassignment occurred.

Google Cloud's existing Web client was inspected under the president account.
Both exact setup callbacks were already registered, alongside the existing
preview and www callbacks. No client configuration or secrets were changed:

- `https://campus2care-interview-provider-setup.vercel.app/api/interview/auth/callback`
- `https://campus2care-interview-provider-setup.vercel.app/api/interview/providers/google/callback`

Leadership sign-in succeeded. The authenticated production status endpoint
initially returned both expected provider identities with `verified: false` at
2026-10-29 18:06:13 UTC. Andrew completed both consent flows. At 18:08:36 UTC,
the same authenticated endpoint returned `verified: true` for BOTH Calendar
`interviews@campus2care.org` and Gmail `contact@campus2care.org`. Each check reads
the encrypted grant, refreshes it and verifies the exact account identity. No
refresh tokens or OAuth codes were exposed or copied.

The old leadership dashboard requires preview-only Blob settings and provider
endpoints, so it cannot serve production OAuth setup reliably. Production now
uses a focused connection view backed by the existing administrator-only
`/api/interview/providers/google/status` endpoint. Preview retains its original
dashboard. The setup view offers only connection and read-only refresh checks.

Production booking, outreach, enrollment, canary, provider writes, staff
invitation approval and worker switches remained false in the configuration
readback. No appointments, messages or Notion writes were performed.

Validation: 219 tests passed; TypeScript and lint passed (one existing unused
variable warning in `test/jarvis-metrics.test.mjs`). The local Webpack production
build passed. The default Turbopack build could not bind a local process port in
this execution environment; GitHub CI must still verify that build path.
New route regression tests cover disabled
authorization, missing/admin roles, origin rejection, independent grant failures,
no-store responses and secret-free status output.

Andrew subsequently created a dedicated production Notion integration with
read/update access to both live pipelines and stored `INTERVIEW_NOTION_LIVE_TOKEN`
as a Production Secret. Its existence and scope were confirmed without reading
the value. Added `GET /api/interview/providers/notion/status`: production setup,
administrator session and exact origin are required. It reads only the two
hard-coded database schemas using the dedicated token, checks database identity,
field types and required workflow options, and returns sanitized checks. It never
queries applicants or performs writes. The connection view now includes both
pipeline checks. Live verification requires an isolated redeployment to load the
new secret and endpoint.

Next: verify the dedicated live Notion integration binding in that build. Controlled
real-provider tests still require explicit test identities and send approval.
