-- 044_derive_age_group_from_dob.sql
--
-- 043 carried division forward but couldn't carry age_group for ~25
-- kids whose existing-org row also had a blank age_group. Rather than
-- leave them blank (which makes the check-in screen show "—" and
-- breaks the weight-restriction validator in expo/utils/playerUtils.ts),
-- derive age_group from date_of_birth using the same rule the client
-- already uses.
--
-- Source of truth: expo/utils/playerUtils.ts -> calculateAgeGroup()
--   dob > 2019-07-01  -> U6
--   dob > 2017-07-01  -> U8
--   dob > 2015-07-01  -> U10
--   dob > 2013-07-01  -> U12
--   dob > 2011-07-01  -> U14
--   else              -> NULL  (too old; will stay blank)
--
-- Scope: only the new Summer 7's org. Idempotent: only writes rows
-- whose age_group is currently blank AND have a non-null DOB AND fall
-- inside the U6..U14 window.

BEGIN;

WITH derived AS (
  SELECT
    rp.id,
    rp.org_id,
    CASE
      WHEN rp.date_of_birth IS NULL                       THEN NULL
      WHEN rp.date_of_birth > DATE '2019-07-01'           THEN 'U6'
      WHEN rp.date_of_birth > DATE '2017-07-01'           THEN 'U8'
      WHEN rp.date_of_birth > DATE '2015-07-01'           THEN 'U10'
      WHEN rp.date_of_birth > DATE '2013-07-01'           THEN 'U12'
      WHEN rp.date_of_birth > DATE '2011-07-01'           THEN 'U14'
      ELSE NULL
    END AS calc_age_group
  FROM public.roster_players rp
  WHERE rp.org_id = '553f476b-d0f1-4f3c-aa63-90bc3be42d36'
    AND coalesce(rp.age_group, '') = ''
)
UPDATE public.roster_players rp
   SET age_group  = d.calc_age_group,
       updated_by = coalesce(rp.updated_by, 'migration-044')
  FROM derived d
 WHERE rp.org_id = d.org_id
   AND rp.id     = d.id
   AND d.calc_age_group IS NOT NULL;

DO $$
DECLARE
  v_total           int;
  v_with_age_group  int;
  v_with_division   int;
  v_with_both       int;
  v_too_old         int;
  v_no_dob          int;
BEGIN
  SELECT
    count(*),
    count(*) FILTER (WHERE coalesce(age_group,'') <> ''),
    count(*) FILTER (WHERE coalesce(division,'')  <> ''),
    count(*) FILTER (WHERE coalesce(age_group,'') <> '' AND coalesce(division,'') <> ''),
    count(*) FILTER (WHERE date_of_birth IS NOT NULL AND date_of_birth <= DATE '2011-07-01'),
    count(*) FILTER (WHERE date_of_birth IS NULL)
    INTO v_total, v_with_age_group, v_with_division, v_with_both, v_too_old, v_no_dob
  FROM public.roster_players
  WHERE org_id = '553f476b-d0f1-4f3c-aa63-90bc3be42d36';

  RAISE NOTICE
    '[044] new org: total=% with_age_group=% with_division=% with_both=% too_old_for_U14=% no_dob=%',
    v_total, v_with_age_group, v_with_division, v_with_both, v_too_old, v_no_dob;
END $$;

COMMIT;
