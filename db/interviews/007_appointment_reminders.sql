-- Widen the message kind check only, on the isolated staging branch.
BEGIN;
ALTER TABLE interview.message DROP CONSTRAINT IF EXISTS message_kind_check;
ALTER TABLE interview.message ADD CONSTRAINT message_kind_check CHECK (kind IN
  ('invitation','verification','confirmation','cancellation','ea_request','ea_reminder','leadership_escalation','appointment_reminder'));
COMMIT;
