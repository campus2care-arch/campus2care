# Production canary rescheduling

`POST /api/interview/production/reschedule` requires the verified invitation,
original reservation ID and a different approved founder slot. It shares the
initial booking's live Notion check, exact email/page allowlists, free/busy check,
team revision locks, capacity and database overlap constraints. The original
must be confirmed with settled integration jobs. Pending replacements are
represented in the existing `reschedule_request` and participant claim tables;
the original is not moved by this request.

The canary worker provisions a deterministic replacement Calendar event with a
separate Meet request. A pending Meet retries without moving the original. The
Notion adapter compares the exact existing booking, date, Meet URL, interviewer
and active scheduled workflow before changing its interview fields. A retry
recognizes a fully applied new binding. Only after that sync succeeds does a
transaction validate the original/team/claims again, switch the reservation,
and preserve old participant claims under a retired key.

The worker then cancels the original event using the stored original operation
key. Only its acknowledgment releases the retired claims and queues the new
confirmation. A crash after switching resumes original-event cleanup without
provisioning another replacement. Gmail delivery uses the shared quarantine-
before-send logic. A new reschedule or cancellation is blocked while replacement
cleanup remains unfinished.

Provider failures quarantine uncertain outcomes for operator reconciliation;
they never silently discard an original or an unconfirmed replacement. No live
reschedule, notification or approved source-slot edit was performed by this
increment. A controlled canary and explicit notification approval remain required.
