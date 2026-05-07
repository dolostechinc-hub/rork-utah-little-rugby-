-- 045_assign_u14_to_aging_out_kids.sql
--
-- 16 kids in the new Summer 7's org were born on or before 2011-07-01,
-- which puts them outside the U14 cutoff defined in
-- expo/utils/playerUtils.ts (dob > 2011-07-01 -> U14). The board
-- decided (option A) to assign them U14 anyway and let coaches/refs
-- handle eligibility on the field.
--
-- Idempotent: only writes rows in the new org whose age_group is still
-- blank AND date_of_birth is on/before the U14 cutoff.

BEGIN;

UPDATE public.roster_players
   SET age_group  = 'U14',
       updated_by = coalesce(updated_by, 'migration-045')
 WHERE org_id = '553f476b-d0f1-4f3c-aa63-90bc3be42d36'
   AND coalesce(age_group, '') = ''
   AND date_of_birth IS NOT NULL
   AND date_of_birth <= DATE '2011-07-01';

DO $$
DECLARE
  v_total          int;
  v_with_age_group int;
  v_u14_total      int;
  v_aged_out       int;
BEGIN
  SELECT
    count(*),
    count(*) FILTER (WHERE coalesce(age_group,'') <> ''),
    count(*) FILTER (WHERE age_group = 'U14'),
    count(*) FILTER (WHERE date_of_birth IS NOT NULL
                     AND date_of_birth <= DATE '2011-07-01')
    INTO v_total, v_with_age_group, v_u14_total, v_aged_out
  FROM public.roster_players
  WHERE org_id = '553f476b-d0f1-4f3c-aa63-90bc3be42d36';

  RAISE NOTICE
    '[045] new org: total=% with_age_group=% u14_total=% aged_out_assigned_u14=%',
    v_total, v_with_age_group, v_u14_total, v_aged_out;
END $$;

COMMIT;
