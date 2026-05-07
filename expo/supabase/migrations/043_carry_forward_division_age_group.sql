-- 043_carry_forward_division_age_group.sql
--
-- Migration 041 imported the Summer 7's roster but left age_group and
-- division blank (the source spreadsheet had those columns empty).
-- For every kid whose name+DOB matches an existing record in the
-- prior org 296fbc1a-..., copy age_group and division forward.
--
-- We deliberately do NOT carry team_name forward — teams are season-
-- specific and Summer 7's draft hasn't happened yet.
--
-- Tie-breaker for duplicate existing matches mirrors 041:
--   prefer rows with a populated division/age_group, then most-recent.
--
-- Idempotent: only writes when the new-org row is currently blank
-- AND the existing row has a non-blank value, so re-runs are no-ops.

BEGIN;

WITH new_rows AS (
  SELECT
    rp.id, rp.org_id,
    rp.first_name, rp.last_name, rp.date_of_birth,
    lower(regexp_replace(unaccent(rp.first_name), '[^a-zA-Z]', '', 'g')) AS fn_n,
    lower(regexp_replace(unaccent(rp.last_name),  '[^a-zA-Z]', '', 'g')) AS ln_n
  FROM public.roster_players rp
  WHERE rp.org_id = '553f476b-d0f1-4f3c-aa63-90bc3be42d36'
    AND (coalesce(rp.age_group,'') = '' OR coalesce(rp.division,'') = '')
),
existing AS (
  SELECT
    rp.id, rp.date_of_birth, rp.age_group, rp.division, rp.updated_at,
    lower(regexp_replace(unaccent(rp.first_name), '[^a-zA-Z]', '', 'g')) AS fn_n,
    lower(regexp_replace(unaccent(rp.last_name),  '[^a-zA-Z]', '', 'g')) AS ln_n
  FROM public.roster_players rp
  WHERE rp.org_id = '296fbc1a-0bec-4599-8b52-53191fb7879f'
    AND (coalesce(rp.age_group,'') <> '' OR coalesce(rp.division,'') <> '')
),
existing_best AS (
  SELECT DISTINCT ON (e.fn_n, e.ln_n, e.date_of_birth)
    e.fn_n, e.ln_n, e.date_of_birth, e.age_group, e.division
  FROM existing e
  ORDER BY
    e.fn_n, e.ln_n, e.date_of_birth,
    (coalesce(e.division,'')  <> '') DESC,
    (coalesce(e.age_group,'') <> '') DESC,
    e.updated_at                     DESC NULLS LAST
)
UPDATE public.roster_players rp
   SET age_group = CASE
                     WHEN coalesce(rp.age_group,'') = '' AND coalesce(eb.age_group,'') <> ''
                       THEN eb.age_group
                     ELSE rp.age_group
                   END,
       division  = CASE
                     WHEN coalesce(rp.division,'')  = '' AND coalesce(eb.division,'')  <> ''
                       THEN eb.division
                     ELSE rp.division
                   END,
       updated_by = coalesce(rp.updated_by, 'migration-043')
  FROM new_rows n
  JOIN existing_best eb
    ON eb.fn_n = n.fn_n
   AND eb.ln_n = n.ln_n
   AND eb.date_of_birth = n.date_of_birth
 WHERE rp.org_id = n.org_id
   AND rp.id     = n.id
   AND (
     (coalesce(rp.age_group,'') = '' AND coalesce(eb.age_group,'') <> '')
     OR
     (coalesce(rp.division,'')  = '' AND coalesce(eb.division,'')  <> '')
   );

DO $$
DECLARE
  v_total int;
  v_with_age_group int;
  v_with_division int;
  v_with_both int;
BEGIN
  SELECT
    count(*),
    count(*) FILTER (WHERE coalesce(age_group,'') <> ''),
    count(*) FILTER (WHERE coalesce(division,'')  <> ''),
    count(*) FILTER (WHERE coalesce(age_group,'') <> '' AND coalesce(division,'') <> '')
    INTO v_total, v_with_age_group, v_with_division, v_with_both
  FROM public.roster_players
  WHERE org_id = '553f476b-d0f1-4f3c-aa63-90bc3be42d36';

  RAISE NOTICE
    '[043] new org: total=% with_age_group=% with_division=% with_both=%',
    v_total, v_with_age_group, v_with_division, v_with_both;
END $$;

COMMIT;
