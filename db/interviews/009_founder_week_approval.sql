-- Explicit one-week founder approval. No recurring template is created.
BEGIN;
ALTER TABLE interview.interviewer_week ADD COLUMN IF NOT EXISTS approval_source text NOT NULL DEFAULT 'ea' CHECK(approval_source IN ('ea','founder'));
ALTER TABLE interview.schedule_slot ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1 CHECK(revision>0);
ALTER TABLE interview.schedule_slot ADD COLUMN IF NOT EXISTS approved_by text;
ALTER TABLE interview.schedule_slot ADD COLUMN IF NOT EXISTS approved_at timestamptz;
UPDATE interview.schedule_slot SET approved_by='president@campus2care.org',approved_at=coalesce(approved_at,now())
 WHERE (starts_at AT TIME ZONE 'America/New_York')::date BETWEEN date '2026-11-02' AND date '2026-11-08'
 AND starts_with(source_reference,'sheet:1H0sVX2fO9koh4bckcuUEzVXaqJMvkwgldEoN6NJVy4o:');
UPDATE interview.interviewer_week w SET approval_source='founder',
 date_overrides=(SELECT jsonb_agg(jsonb_build_object('date',to_char(w.week_start+(day->>'weekday')::integer,'YYYY-MM-DD'),'kind','replace','windows',day->'windows') ORDER BY (day->>'weekday')::integer) FROM jsonb_array_elements(w.effective_windows) day),
 effective_windows='[]'::jsonb,revision=revision+1,updated_at=now()
 WHERE w.week_start='2026-11-02' AND w.approval_source='ea'
 AND EXISTS(SELECT 1 FROM interview.schedule_slot s JOIN interview.schedule_participant p ON p.slot_id=s.id WHERE p.participant_id=w.interviewer_id AND s.approved_by='president@campus2care.org');
COMMIT;
