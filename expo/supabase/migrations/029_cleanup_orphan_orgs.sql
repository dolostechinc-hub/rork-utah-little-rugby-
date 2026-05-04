-- 029_cleanup_orphan_orgs.sql
--
-- Cleans up two orphan org_ids in public.roster_players:
--
--   * bf001d3a-536c-4f02-a996-f4d73220d309 -- 1,099 rows
--   * cbfc7678-31db-488c-b100-19a4c323f088 -- 2,307 rows
--
-- Both org_ids are TRULY orphan: no row exists in public.organizations
-- with these ids, so they're dangling foreign keys, not "renamed orgs
-- we forgot about." Both look like the residue of early bulk imports
-- (cbfc7678 imports clustered around 2026-04-23 04:34, bf001d3a around
-- 2026-04-26 02:02:53).
--
-- AUDIT FINDINGS THAT JUSTIFY DELETION:
--
-- 1. bf001d3a is 100% safe to delete:
--    * 1,099 rows, ZERO with rich data (no verified, no photo, no
--      weight, no checked_in).
--    * Every row has a (first_name, last_name, date_of_birth) twin
--      in a real org (Q3 reported 1099/1099 with real-org twin).
--    * No information will be lost.
--
-- 2. cbfc7678 has 2,307 rows with three buckets:
--    * 2,295 rows duplicated in real orgs (Q3): safe to delete.
--    * 12 rows with no real-org twin (Q5): all are obvious test
--      data (Donald Duck, Mickey Mouse, Michael Jackson, Jane Doe,
--      John Doe, Jimmy Buffet, etc.) with free-text date_of_birth
--      values ("January1, 2016", "Jan 1, 2014", "September 18, 2016")
--      that don't match the real M/D/YYYY format used elsewhere.
--      Classic smoke-test data dump from the early days of the app.
--      Safe to delete.
--    * 3 rows with rich data (Q6): Mike Braun 3/13/2015,
--      Lyla Erickson 12/7/2014, Gordy Mucha 8/12/2015 -- all are
--      real registered players whose ULR Spring 2026 row currently
--      lacks the verification/photo/weight/checked_in state that
--      lives on these orphan rows. We MERGE that rich data into
--      Spring 2026 BEFORE deleting the orphans.
--
-- MERGE SEMANTICS:
--   The merge is field-level "only fill where the Spring twin is
--   missing" logic:
--     * is_age_verified -> OR'd (orphan can promote twin from
--       false -> true; never demotes)
--     * photo_uri  -> copied iff twin.photo_uri is null/blank
--     * weight     -> copied iff twin.weight is null/blank
--     * checked_in -> OR'd (orphan can promote twin to checked-in)
--     * checked_in_at -> copied iff twin.checked_in_at is null
--   This means Gordy Mucha (Spring twin already has photo(172),
--   weight=120, checked_in=true 2026-04-24) is effectively a no-op:
--   the orphan's older photo(160) and weight=150 are NOT overwritten.
--   Mike Braun and Lyla Erickson (Spring twin has nothing rich)
--   pick up the orphan's full rich payload.
--
-- SCOPE NOTE:
--   This migration only merges into ULR Spring 2026 (07c516a0...).
--   Summer 7's, SundayMorning, Testing, and other orgs that also
--   carry these players are left untouched -- whether last season's
--   age verification "carries over" to a different season is a policy
--   question, not a data-recovery one. RECOV2026 is also left
--   untouched as a forensic backup.

DO $$
DECLARE
  v_orphan_a CONSTANT text := 'bf001d3a-536c-4f02-a996-f4d73220d309';
  v_orphan_b CONSTANT text := 'cbfc7678-31db-488c-b100-19a4c323f088';
  v_spring   CONSTANT text := '07c516a0-73bc-4fdd-8b39-ee27e2242eca';

  v_a_before          INTEGER;
  v_b_before          INTEGER;
  v_rich_in_b         INTEGER;
  v_merge_candidates  INTEGER;
  v_merged            INTEGER;
  v_deleted_a         INTEGER;
  v_deleted_b         INTEGER;
  v_a_after           INTEGER;
  v_b_after           INTEGER;
BEGIN
  -- Pre-flight counts.
  SELECT count(*) INTO v_a_before FROM public.roster_players WHERE org_id = v_orphan_a;
  SELECT count(*) INTO v_b_before FROM public.roster_players WHERE org_id = v_orphan_b;

  SELECT count(*) INTO v_rich_in_b
    FROM public.roster_players
   WHERE org_id = v_orphan_b
     AND (coalesce(is_age_verified,false)
          OR (photo_uri IS NOT NULL AND photo_uri <> '')
          OR (weight    IS NOT NULL AND weight    <> '')
          OR coalesce(checked_in,false));

  -- Count: how many Spring rows match a rich orphan and would actually
  -- gain at least one field from the merge?
  SELECT count(DISTINCT spring.id)
    INTO v_merge_candidates
    FROM public.roster_players spring
    JOIN public.roster_players orphan
      ON orphan.org_id = v_orphan_b
     AND lower(trim(coalesce(spring.first_name,''))) = lower(trim(coalesce(orphan.first_name,'')))
     AND lower(trim(coalesce(spring.last_name,'')))  = lower(trim(coalesce(orphan.last_name,'')))
     AND coalesce(spring.date_of_birth,'')           = coalesce(orphan.date_of_birth,'')
   WHERE spring.org_id = v_spring
     AND (coalesce(orphan.is_age_verified,false)
          OR (orphan.photo_uri IS NOT NULL AND orphan.photo_uri <> '')
          OR (orphan.weight    IS NOT NULL AND orphan.weight    <> '')
          OR coalesce(orphan.checked_in,false))
     AND (
       -- Spring is missing at least one rich field that orphan has
       (coalesce(spring.is_age_verified,false) = false AND coalesce(orphan.is_age_verified,false))
       OR ((spring.photo_uri IS NULL OR spring.photo_uri = '')
           AND (orphan.photo_uri IS NOT NULL AND orphan.photo_uri <> ''))
       OR ((spring.weight    IS NULL OR spring.weight    = '')
           AND (orphan.weight    IS NOT NULL AND orphan.weight    <> ''))
       OR (coalesce(spring.checked_in,false) = false AND coalesce(orphan.checked_in,false))
     );

  RAISE NOTICE 'Pre-cleanup: bf001d3a=% rows, cbfc7678=% rows (% rich), Spring rows that would gain data=%',
    v_a_before, v_b_before, v_rich_in_b, v_merge_candidates;

  -- 1) Surgical merge of rich orphan data into Spring 2026 twins.
  WITH merged AS (
    UPDATE public.roster_players spring
       SET is_age_verified  = coalesce(spring.is_age_verified, false)
                              OR coalesce(orphan.is_age_verified, false),
           photo_uri        = CASE
                                WHEN spring.photo_uri IS NULL OR spring.photo_uri = ''
                                  THEN orphan.photo_uri
                                ELSE spring.photo_uri
                              END,
           weight           = CASE
                                WHEN spring.weight IS NULL OR spring.weight = ''
                                  THEN orphan.weight
                                ELSE spring.weight
                              END,
           checked_in       = coalesce(spring.checked_in, false)
                              OR coalesce(orphan.checked_in, false),
           checked_in_at    = CASE
                                WHEN spring.checked_in_at IS NULL
                                  THEN orphan.checked_in_at
                                ELSE spring.checked_in_at
                              END,
           client_updated_at = greatest(
             coalesce(spring.client_updated_at, '1970-01-01'::timestamptz),
             coalesce(orphan.client_updated_at, '1970-01-01'::timestamptz)
           )
      FROM public.roster_players orphan
     WHERE spring.org_id = v_spring
       AND orphan.org_id = v_orphan_b
       AND lower(trim(coalesce(spring.first_name,''))) = lower(trim(coalesce(orphan.first_name,'')))
       AND lower(trim(coalesce(spring.last_name,'')))  = lower(trim(coalesce(orphan.last_name,'')))
       AND coalesce(spring.date_of_birth,'')           = coalesce(orphan.date_of_birth,'')
       AND (coalesce(orphan.is_age_verified,false)
            OR (orphan.photo_uri IS NOT NULL AND orphan.photo_uri <> '')
            OR (orphan.weight    IS NOT NULL AND orphan.weight    <> '')
            OR coalesce(orphan.checked_in,false))
       -- Only update rows where at least one field actually changes
       AND (
         (coalesce(spring.is_age_verified,false) = false AND coalesce(orphan.is_age_verified,false))
         OR ((spring.photo_uri IS NULL OR spring.photo_uri = '')
             AND (orphan.photo_uri IS NOT NULL AND orphan.photo_uri <> ''))
         OR ((spring.weight    IS NULL OR spring.weight    = '')
             AND (orphan.weight    IS NOT NULL AND orphan.weight    <> ''))
         OR (coalesce(spring.checked_in,false) = false AND coalesce(orphan.checked_in,false))
       )
    RETURNING 1
  )
  SELECT count(*) INTO v_merged FROM merged;

  RAISE NOTICE 'Merged rich orphan data into % Spring rows.', v_merged;

  -- 2) Delete every row in the two orphan orgs.
  WITH deleted AS (
    DELETE FROM public.roster_players WHERE org_id = v_orphan_a RETURNING 1
  )
  SELECT count(*) INTO v_deleted_a FROM deleted;

  WITH deleted AS (
    DELETE FROM public.roster_players WHERE org_id = v_orphan_b RETURNING 1
  )
  SELECT count(*) INTO v_deleted_b FROM deleted;

  RAISE NOTICE 'Deleted: bf001d3a=% rows, cbfc7678=% rows.', v_deleted_a, v_deleted_b;

  -- 3) Sanity gates.
  SELECT count(*) INTO v_a_after FROM public.roster_players WHERE org_id = v_orphan_a;
  SELECT count(*) INTO v_b_after FROM public.roster_players WHERE org_id = v_orphan_b;

  IF v_a_after <> 0 OR v_b_after <> 0 THEN
    RAISE EXCEPTION 'Orphan rows still present after cleanup: bf001d3a=%, cbfc7678=%. Aborting.',
      v_a_after, v_b_after;
  END IF;

  IF v_merged <> v_merge_candidates THEN
    RAISE EXCEPTION 'Merge mismatch: planned to update % Spring rows, actually updated %. Aborting.',
      v_merge_candidates, v_merged;
  END IF;

  IF v_deleted_a <> v_a_before OR v_deleted_b <> v_b_before THEN
    RAISE EXCEPTION 'Delete mismatch: bf001d3a planned=%, actual=%; cbfc7678 planned=%, actual=%. Aborting.',
      v_a_before, v_deleted_a, v_b_before, v_deleted_b;
  END IF;

  RAISE NOTICE 'Orphan org cleanup complete.';
END
$$;

-- After applying:
--   1. Reload Expo Go on ULR Spring 2026. Spot-check Mike Braun
--      (3/13/2015) and Lyla Erickson (12/7/2014) -- both should now
--      show the green age-verified badge with their photo + weight.
--   2. Confirm via SELECT count(*) FROM public.roster_players
--      WHERE org_id IN ('bf001d3a-536c-4f02-a996-f4d73220d309',
--                       'cbfc7678-31db-488c-b100-19a4c323f088');
--      Expected: 0.
