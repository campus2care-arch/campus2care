# Campus application and availability recovery

Production uses the existing private `campus2care-submissions-production` Blob store. Preview does not use that store or the four production Notion databases. Both public forms require an explicit university selection.

Validated answers are durably saved before Notion writes. Receipt paths contain hashed submission IDs, without applicant names or email addresses. A campus-wide conditional lock serializes application and availability writes, including requests with different IDs for the same person. Completed retries return the saved result. Reusing an ID with changed answers returns a conflict. Existing applicant workflow, owner, and original application fields are preserved.

Only a successful write of all required Notion records produces `ok: true`. An incomplete sync returns an error with `recoverable: true` when a durable receipt exists. Logs contain only campus, submission kind, and a fixed error code. Notion response bodies and applicant answers are never logged.

## Replay

An authenticated `GET /api/submissions/replay` retries queued or safely failed receipts, at most three per request. It returns counts and HTTP statuses, with a cursor when another page is available. The `Authorization: Bearer ...` value is the production `CRON_SECRET`, held only in Vercel's secret configuration. Never paste it into a public URL, log, or document. Vercel's daily Hobby-compatible cron invokes the same endpoint at 10:00 UTC. Applicants can retry immediately using the same submission ID.

Use the returned cursor for additional receipt pages. Repeated calls from the beginning finish remaining queued receipts on that page before proceeding. This is bounded replay rather than a promise of immediate background delivery during an outage.

## Uncertain writes and crashed workers

Before a Notion page create, the receipt records the pending operation. If the create times out or its outcome is uncertain, the receipt is held as `review_required`; automatic replay does not guess whether the page exists. A crashed worker's campus lock also remains in place. These holds deliberately require an operator to inspect the exact submission ID and email in the intended campus databases before retrying.

To release a hold: verify that the worker is no longer running; read the receipt privately; search both target Notion databases for its exact submission ID and validated identity; preserve and reconcile any landed records; clear the pending marker only after the create outcome is known; then remove the matching stale campus lock and replay the original receipt. Do not create replacement records merely because an HTTP request failed. Keep the original payload and received timestamp unchanged.

## Controlled verification

The authenticated `POST /api/submissions/replay` accepts `{kind: "application", payload: ...}` solely for identities whose name begins `C2C QA ` and whose email ends `@example.invalid`. It simulates a pre-write Notion failure after storing the receipt. Submit the same normalized payload to `/api/application` to verify recovery. It cannot inject failures into real applicants' submissions.

All test records must be visibly synthetic. Record IDs and relationships before cleanup. Archive only those exact synthetic pages, and remove their private receipts after checking their completed status. Preserve real applicant data and permissions.

## Release controls

Build and test a production-target deployment with automatic custom-domain assignment disabled. Verify BU, BC, Other, standalone availability, retries, recovery, and Notion readback before merging. Promote the deployment built from the merged commit only after confirming its exact SHA. If public-form verification fails, immediately roll back to the recorded working deployment.
