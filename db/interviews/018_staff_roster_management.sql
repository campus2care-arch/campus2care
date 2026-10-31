-- Additive only. Founder-managed interviewer roster: sign-in access, lead or
-- shadower role, and shadower-to-lead assignment. Removal is a timestamp so
-- availability and interview history are preserved.
BEGIN;
ALTER TABLE interview.interviewer
  ADD COLUMN IF NOT EXISTS team_role text NOT NULL DEFAULT 'lead'
    CHECK (team_role IN ('lead','shadow')),
  ADD COLUMN IF NOT EXISTS lead_interviewer_id uuid REFERENCES interview.interviewer(id),
  ADD COLUMN IF NOT EXISTS staff_access boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS invited_at timestamptz,
  ADD COLUMN IF NOT EXISTS removed_at timestamptz;
DO $$ BEGIN
  ALTER TABLE interview.interviewer ADD CONSTRAINT interview_interviewer_not_own_lead
    CHECK (lead_interviewer_id IS NULL OR lead_interviewer_id <> id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Existing roster: everyone keeps sign-in; inactive people were shadow-only.
UPDATE interview.interviewer SET staff_access = true,
  team_role = CASE WHEN active AND weekly_capacity_limit > 0 THEN 'lead' ELSE 'shadow' END
  WHERE removed_at IS NULL AND staff_access = false;
COMMIT;
