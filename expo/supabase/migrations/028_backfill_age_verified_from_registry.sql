-- 028_backfill_age_verified_from_registry.sql
--
-- Restore is_age_verified=true on ULR Spring 2026 roster_players rows
-- whose (first_name, last_name, date_of_birth) matches a row in
-- age_verified_registry, but where is_age_verified is currently false.
--
-- WHY THIS EXISTS:
--   The pre-hardening dedupe bug + the earlier "recovery-merge-7h"
--   process (visible in updated_by on rows in RECOV2026) cleared the
--   is_age_verified flag on a subset of roster rows. RECOV2026 itself
--   captured the post-clear state for those players, so migration 026
--   restored them as unverified.
--
--   age_verified_registry, however, persistently records every
--   verification event ever performed for an org. That's our actual
--   source of truth for "who is verified". Diagnosed from Reign
--   Afalava (07c516a0..., 10/17/2016): registry verified_at =
--   2026-04-26 19:00:57, but RECOV2026 had her at is_age_verified=false
--   at 2026-04-28 04:30, so 026 also restored her as unverified.
--
-- WHAT THIS MIGRATION DOES NOT DO:
--   * Does not restore photo_uri. The registry doesn't store photos,
--     so any verified player whose photo_uri didn't survive in
--     RECOV2026 will need to be re-photographed in the app. A
--     follow-up audit query is recommended to count those.
--   * Does not run for orgs other than Spring 2026. The orphan orgs
--     (cbfc7678..., bf001d3a...) and SundayMorning need their own
--     audit before we apply broad cross-org backfills.
--
-- TRIGGER NOTES:
--   * trg_roster_players_touch will bump updated_at, fanning out a
--     postgres_changes event so connected clients refresh.
--   * protect_roster_rich_data_trigger (BEFORE UPDATE) only intervenes
--     to prevent rich-data downgrades. We're upgrading
--     is_age_verified from false -> true, so the trigger lets the
--     update through unchanged.
--   * block_blank_roster_inserts_trigger was removed in 027, so it
--     can't interfere even if it ever fired on UPDATE (it didn't).
--
-- IDEMPOTENT:
--   * The WHERE clause requires is_age_verified=false, so a re-run
--     after success is a no-op.

DO $$
DECLARE
  v_to_fix      INTEGER;
  v_updated     INTEGER;
  v_still_unverified INTEGER;
BEGIN
  -- Pre-flight: count how many Spring rows are currently unverified
  -- but match a registry entry.
  SELECT count(*)
    INTO v_to_fix
    FROM public.roster_players rp
    JOIN public.age_verified_registry v
      ON v.org_id = rp.org_id
     AND lower(trim(coalesce(rp.first_name, '')))
         = lower(trim(coalesce(v.first_name, '')))
     AND lower(trim(coalesce(rp.last_name, '')))
         = lower(trim(coalesce(v.last_name, '')))
     AND coalesce(rp.date_of_birth, '')
         = coalesce(v.date_of_birth, '')
   WHERE rp.org_id = '07c516a0-73bc-4fdd-8b39-ee27e2242eca'
     AND coalesce(rp.is_age_verified, false) = false;

  RAISE NOTICE 'Pre-backfill: % Spring 2026 rows currently unverified but in registry.', v_to_fix;

  -- Backfill.
  WITH bumped AS (
    UPDATE public.roster_players rp
       SET is_age_verified  = true,
           client_updated_at = greatest(
             coalesce(rp.client_updated_at, '1970-01-01'::timestamptz),
             coalesce(v.verified_at, now())
           )
      FROM public.age_verified_registry v
     WHERE rp.org_id = '07c516a0-73bc-4fdd-8b39-ee27e2242eca'
       AND v.org_id = rp.org_id
       AND lower(trim(coalesce(rp.first_name, '')))
           = lower(trim(coalesce(v.first_name, '')))
       AND lower(trim(coalesce(rp.last_name, '')))
           = lower(trim(coalesce(v.last_name, '')))
       AND coalesce(rp.date_of_birth, '')
           = coalesce(v.date_of_birth, '')
       AND coalesce(rp.is_age_verified, false) = false
    RETURNING 1
  )
  SELECT count(*) INTO v_updated FROM bumped;

  -- Post-flight: how many registry entries STILL don't have a verified
  -- roster row in Spring? (e.g. registry for someone whose roster row
  -- has a slightly different name spelling, or who was deleted entirely.)
  SELECT count(*)
    INTO v_still_unverified
    FROM public.age_verified_registry v
   WHERE v.org_id = '07c516a0-73bc-4fdd-8b39-ee27e2242eca'
     AND NOT EXISTS (
       SELECT 1 FROM public.roster_players rp
        WHERE rp.org_id = v.org_id
          AND lower(trim(coalesce(rp.first_name, '')))
              = lower(trim(coalesce(v.first_name, '')))
          AND lower(trim(coalesce(rp.last_name, '')))
              = lower(trim(coalesce(v.last_name, '')))
          AND coalesce(rp.date_of_birth, '')
              = coalesce(v.date_of_birth, '')
          AND rp.is_age_verified = true
     );

  RAISE NOTICE 'Backfilled is_age_verified=true on % rows. Registry entries still without a verified roster match: %.',
    v_updated, v_still_unverified;

  -- Sanity: we should have updated exactly v_to_fix rows.
  IF v_updated <> v_to_fix THEN
    RAISE EXCEPTION 'Backfill mismatch: planned to update % rows, actually updated %. Aborting.',
      v_to_fix, v_updated;
  END IF;
END
$$;
