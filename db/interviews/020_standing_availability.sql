-- Standing availability backfill. Review before applying. Do not run against
-- production from a branch deploy, and do not send email from this script.
--
-- Staff who confirmed a week through the availability page stored the hours
-- they typed as date_overrides on top of seven empty effective_windows, and
-- never got an interviewer_template row. This copies the latest staff-confirmed
-- week that actually has hours into the recurring template, and moves those
-- hours onto effective_windows for that same week. Founder-approved weeks are
-- left as date-specific overrides so existing BC interviews stay put.
--
-- president@campus2care.org can host BU in addition to BC, with BC remaining
-- the first campus. Cayla McKay and Hannah Dooley, the BU shadowers, are
-- assigned to him. Slot rows are not inserted here. After this is applied and
-- the app is deployed, saving the lead's hours publishes BU slots where the
-- shadowers' saved hours overlap.

BEGIN;

WITH latest AS (
  SELECT DISTINCT ON (w.interviewer_id)
    w.interviewer_id, w.week_start, w.effective_windows, w.date_overrides
  FROM interview.interviewer_week w
  WHERE w.status = 'confirmed' AND w.approval_source = 'ea'
  ORDER BY w.interviewer_id, w.week_start DESC
),
folded AS (
  SELECT interviewer_id, week_start,
    CASE
      WHEN EXISTS (
        SELECT 1 FROM jsonb_array_elements(effective_windows) day
        WHERE jsonb_array_length(COALESCE(day->'windows', '[]'::jsonb)) > 0
      ) THEN effective_windows
      ELSE (
        SELECT jsonb_agg(jsonb_build_object(
          'weekday', weekday,
          'windows', COALESCE((
            SELECT ov->'windows'
            FROM jsonb_array_elements(date_overrides) ov
            WHERE ov->>'kind' = 'replace'
              AND ov->>'date' = to_char(week_start + weekday, 'YYYY-MM-DD')
            LIMIT 1
          ), '[]'::jsonb)
        ) ORDER BY weekday)
        FROM generate_series(0, 6) AS weekday
      )
    END AS windows
  FROM latest
),
usable AS (
  SELECT interviewer_id, week_start, windows FROM folded
  WHERE EXISTS (
    SELECT 1 FROM jsonb_array_elements(windows) day
    WHERE jsonb_array_length(COALESCE(day->'windows', '[]'::jsonb)) > 0
  )
)
INSERT INTO interview.interviewer_template (interviewer_id, recurring_windows)
SELECT interviewer_id, windows FROM usable
WHERE NOT EXISTS (
  SELECT 1 FROM interview.interviewer_template t WHERE t.interviewer_id = usable.interviewer_id
);

WITH latest AS (
  SELECT DISTINCT ON (w.interviewer_id)
    w.interviewer_id, w.week_start, w.effective_windows, w.date_overrides
  FROM interview.interviewer_week w
  WHERE w.status = 'confirmed' AND w.approval_source = 'ea'
  ORDER BY w.interviewer_id, w.week_start DESC
),
folded AS (
  SELECT interviewer_id, week_start,
    CASE
      WHEN EXISTS (
        SELECT 1 FROM jsonb_array_elements(effective_windows) day
        WHERE jsonb_array_length(COALESCE(day->'windows', '[]'::jsonb)) > 0
      ) THEN NULL
      ELSE (
        SELECT jsonb_agg(jsonb_build_object(
          'weekday', weekday,
          'windows', COALESCE((
            SELECT ov->'windows'
            FROM jsonb_array_elements(date_overrides) ov
            WHERE ov->>'kind' = 'replace'
              AND ov->>'date' = to_char(week_start + weekday, 'YYYY-MM-DD')
            LIMIT 1
          ), '[]'::jsonb)
        ) ORDER BY weekday)
        FROM generate_series(0, 6) AS weekday
      )
    END AS windows
  FROM latest
)
UPDATE interview.interviewer_week w
SET effective_windows = folded.windows,
    date_overrides = '[]'::jsonb,
    revision = w.revision + 1,
    updated_at = now()
FROM folded
WHERE w.interviewer_id = folded.interviewer_id
  AND w.week_start = folded.week_start
  AND w.approval_source = 'ea'
  AND folded.windows IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(folded.windows) day
    WHERE jsonb_array_length(COALESCE(day->'windows', '[]'::jsonb)) > 0
  );

UPDATE interview.interviewer
SET allowed_campuses = ARRAY['BC','BU']::text[], updated_at = now()
WHERE lower(workspace_email) = 'president@campus2care.org'
  AND allowed_campuses = ARRAY['BC']::text[];

UPDATE interview.interviewer AS shadow
SET lead_interviewer_id = lead.id, updated_at = now()
FROM interview.interviewer AS lead
WHERE lower(lead.workspace_email) = 'president@campus2care.org'
  AND lower(shadow.workspace_email) IN (
    'cayla.mckay@campus2care.org',
    'hannah.dooley@campus2care.org'
  )
  AND shadow.team_role = 'shadow'
  AND shadow.removed_at IS NULL
  AND shadow.lead_interviewer_id IS DISTINCT FROM lead.id;

COMMIT;
