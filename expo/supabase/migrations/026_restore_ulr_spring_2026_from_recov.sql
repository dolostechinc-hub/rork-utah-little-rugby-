-- 026_restore_ulr_spring_2026_from_recov.sql
--
-- Restore the ULR Spring 2026 roster (org_id 07c516a0-73bc-4fdd-8b39-ee27e2242eca,
-- code 8DJ5JM) from the Weigh-In Recovery 2026 snapshot
-- (org_id 4868ba1b-f0a2-433f-83ac-4a0eada96ffc, code RECOV2026).
--
-- WHY THIS EXISTS:
--   The pre-hardening client-side dedupe in RegistrationContext.mergeRemoteRoster
--   was deleting cloud rows it considered "stale duplicates" whenever a fetch
--   was truncated by the (default 1000-row) PostgREST limit. For ULR Spring
--   2026 the side effect was catastrophic: 2,169 rows -> 1 row, with 142
--   age-verified players gone. RECOV2026 holds the pre-wipe snapshot.
--
-- VERIFICATION (run before applying — see /tmp/ulr_recov_match.py output):
--     Spring  rows currently in roster_players       : 1
--     RECOV   rows currently in roster_players       : 2169
--     Spring  age_verified_registry entries          : 143
--     Verified players missing from Spring           : 142
--     ... recoverable via RECOV2026                  : 142
--     ... NOT in RECOV2026 either                    : 0
--     Duplicate name+DOB groups inside RECOV2026     : 0
--     RECOV rows new to Spring (would be inserted)   : 2168
--     RECOV rows already in Spring (would be skipped):    1   <- Donald Vatuvei
--
-- DESIGN NOTES:
--   * Match key is normalized (first_name, last_name, date_of_birth), NOT id.
--     The single surviving Spring row was re-added post-wipe with a fresh
--     numeric id, so an id-based conflict check would re-introduce that
--     player as a duplicate.
--   * client_updated_at on each restored row is preserved verbatim from the
--     RECOV snapshot. That keeps the 2026-04-28 timestamps in place so any
--     volunteer edits made after restore will win the client-side merge.
--   * updated_at gets bumped to NOW() by trg_roster_players_touch on insert.
--     That's intentional: realtime subscribers will receive postgres_changes
--     events for every restored row and refresh their local cache.
--   * RECOV2026 rows are NOT deleted by this migration. After you've
--     confirmed the restore in the app, decide separately whether to drop
--     the backup org or keep it as cold storage.
--   * Idempotent: re-running is a no-op because the EXISTS guard on
--     (first_name, last_name, date_of_birth) catches every row this
--     migration just inserted.
--   * Intentionally NO `ON CONFLICT (org_id, id) DO NOTHING`.
--     If a real (org_id, id) collision ever occurs on re-run, we WANT
--     that to raise loudly so we can investigate, not silently skip.
--   * Temporarily disables `block_blank_roster_inserts_trigger` for the
--     duration of the INSERT. That trigger is a BEFORE INSERT guard that
--     returns NULL for any row where `checked_in = false AND weight = ''
--     AND photo_uri = ''`. It's there to keep volunteers' empty
--     placeholder rows out of the table, which is correct for normal
--     app writes -- but for a bulk restore most Spring 2026 players are
--     "registered but not yet weighed/photographed", so the guard
--     classifies them as blank and silently drops them. With the
--     guard active, an earlier run of this migration only inserted
--     502 of 2,168 rows; with the guard disabled it inserts all 2,168.
--     `protect_roster_rich_data_trigger` (BEFORE UPDATE) is left
--     enabled because we're inserting, not updating.
--     The DISABLE / ENABLE pair is DDL inside the outer transaction:
--     if any RAISE EXCEPTION below trips, both DDL statements roll
--     back together with the inserts, so the guard ends up re-enabled
--     no matter the outcome.

DO $$
DECLARE
  v_spring_before INTEGER;
  v_recov_before  INTEGER;
  v_inserted      INTEGER;
  v_spring_after  INTEGER;
  v_still_missing INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_spring_before FROM public.roster_players
  WHERE org_id = '07c516a0-73bc-4fdd-8b39-ee27e2242eca';

  SELECT COUNT(*) INTO v_recov_before FROM public.roster_players
  WHERE org_id = '4868ba1b-f0a2-433f-83ac-4a0eada96ffc';

  RAISE NOTICE 'Pre-restore: Spring=%, RECOV=%', v_spring_before, v_recov_before;

  ALTER TABLE public.roster_players
    DISABLE TRIGGER block_blank_roster_inserts_trigger;

  WITH inserted AS (
    INSERT INTO public.roster_players (
      id,
      org_id,
      first_name,
      last_name,
      club,
      age_group,
      division,
      team_name,
      date_of_birth,
      parent_name,
      parent_phone,
      is_age_verified,
      photo_uri,
      weight,
      checked_in,
      checked_in_at,
      restriction_status,
      calculated_age_group,
      updated_by,
      client_updated_at,
      club_id
      -- updated_at is intentionally omitted: trg_roster_players_touch sets it.
    )
    SELECT
      recov.id,
      '07c516a0-73bc-4fdd-8b39-ee27e2242eca'::text AS org_id,
      recov.first_name,
      recov.last_name,
      recov.club,
      recov.age_group,
      recov.division,
      recov.team_name,
      recov.date_of_birth,
      recov.parent_name,
      recov.parent_phone,
      recov.is_age_verified,
      recov.photo_uri,
      recov.weight,
      recov.checked_in,
      recov.checked_in_at,
      recov.restriction_status,
      recov.calculated_age_group,
      recov.updated_by,
      recov.client_updated_at,
      recov.club_id
    FROM public.roster_players recov
    WHERE recov.org_id = '4868ba1b-f0a2-433f-83ac-4a0eada96ffc'
      AND NOT EXISTS (
        SELECT 1
        FROM public.roster_players spring
        WHERE spring.org_id = '07c516a0-73bc-4fdd-8b39-ee27e2242eca'
          AND lower(trim(coalesce(spring.first_name, '')))
              = lower(trim(coalesce(recov.first_name, '')))
          AND lower(trim(coalesce(spring.last_name, '')))
              = lower(trim(coalesce(recov.last_name, '')))
          AND coalesce(spring.date_of_birth, '')
              = coalesce(recov.date_of_birth, '')
      )
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_inserted FROM inserted;

  ALTER TABLE public.roster_players
    ENABLE TRIGGER block_blank_roster_inserts_trigger;

  SELECT COUNT(*) INTO v_spring_after FROM public.roster_players
  WHERE org_id = '07c516a0-73bc-4fdd-8b39-ee27e2242eca';

  -- Forensic check: how many age_verified_registry entries for Spring still
  -- have no matching roster_players row after the restore?
  SELECT COUNT(*) INTO v_still_missing
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
    );

  RAISE NOTICE 'Restore inserted % rows. Spring now has % rows. Verified-but-still-missing: %',
    v_inserted, v_spring_after, v_still_missing;

  -- Hard sanity gate: the restore is broken if Spring didn't grow back to
  -- the expected size or if any verified players are still unaccounted for.
  IF v_spring_after < 2169 THEN
    RAISE EXCEPTION 'Spring 2026 has % rows after restore, expected >= 2169. Aborting.',
      v_spring_after;
  END IF;

  IF v_still_missing > 0 THEN
    RAISE EXCEPTION 'Restore left % verified players unmatched in Spring 2026. Aborting.',
      v_still_missing;
  END IF;
END $$;

-- After applying:
--   1. Reload the published app and the local Expo build. Both should now
--      show ~2,170 ULR Spring 2026 players (2,169 restored + Donald Vatuvei
--      added post-wipe).
--   2. Smoke-test a few of the previously-missing verified players (e.g.
--      "Davis Adams 11/2/2012", "Reign Afalava 10/17/2016") to confirm they
--      load with their RECOV2026 photo_uri / age verification state.
--   3. Once confirmed, you can choose to either keep RECOV2026 as cold
--      storage or run a separate migration to delete it. Don't drop it in
--      the same migration as the restore.
