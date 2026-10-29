# Production canary cancellation

`POST /api/interview/production/cancel` accepts the verified invitation bearer
token and reservation ID at the configured origin. The existing production
canary gate and BOTH recipient/page allowlists remain mandatory. This is not a
public launch or a general production cancellation endpoint.

The request locks the invitation, reservation, contact and existing outbox jobs.
It rejects an active worker lease or unfinished replacement, suppresses queued
confirmation work, and changes the reservation to `cancel_pending`. Participant
claims remain held. A canceled or cancel-pending request is idempotent.

The worker verifies the deterministic event ID and private operation marker
before deleting with `sendUpdates=all`; staff-notification approval is still
required. Missing events and canceled tombstones are idempotent. Unknown provider
outcomes remain reconciliation-required and retain claims.

After Calendar acknowledges cancellation, the worker marks the reservation
canceled, releasing its participant claims through the existing database trigger.
It then clears only the exact matching Notion booking and only the existing
interview fields. A different booking, completed interview, changed workflow,
campus/email mismatch or inactive applicant is quarantined. Notes, owners,
availability and other properties are never patched. A cancellation email is
queued only after Notion cleanup succeeds; Gmail's existing ambiguous-send
quarantine prevents blind resend.

No live cancellation or notification has been executed by this increment.
Provider and worker tests use synthetic transports. A real canary still needs
approved test identities, exact notification recipients, verified Calendar
refresh, and explicit activation. Original approved slots/assignments are never
modified by these operations.
