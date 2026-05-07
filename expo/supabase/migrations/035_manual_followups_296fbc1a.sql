-- 035_manual_followups_296fbc1a.sql
--
-- Final two manual cleanups for org 296fbc1a-0bec-4599-8b52-53191fb7879f
-- after the dedupe (033) and mojibake repair (034) passes.
--
-- Step A. Fix Niko Tlaiasau's last_name. An email address ended up in
-- the last_name column ("Tlaiasau@icloud.com"). Replace with the
-- correct last name "Tlaiasau".
--
-- Step B. Collapse the two Lautelu (LT) rows for the same kid (same
-- first_name, same DOB 2017-04-13, last_name differs only by an okina
-- apostrophe). Keep the spelling WITHOUT the apostrophe ("Tuipulotu"),
-- merge any rich fields from the okina-spelled row onto it, then
-- delete the okina-spelled row.
--
-- The Va'atausili Houma DOB ambiguity is intentionally left for the
-- team to confirm offline.
--
-- Hard preconditions: exact row counts must match what we observed.
-- Any drift aborts the entire transaction.

BEGIN;

DO $$
DECLARE
  v_org                 TEXT := '296fbc1a-0bec-4599-8b52-53191fb7879f';
  v_niko_id_count       INTEGER;
  v_niko_updates        INTEGER;
  v_lautelu_loser_id    TEXT := 'imported-1777245860424-410';   -- Lautelu (LT) Tu'ipulotu (with apostrophe)
  v_lautelu_winner_id   TEXT := 'imported-1776890375799-139';   -- Lautelu (LT) Tuipulotu  (no apostrophe)
  v_lautelu_loser_seen  INTEGER;
  v_lautelu_winner_seen INTEGER;
  v_lautelu_deletes     INTEGER;
  v_remaining           INTEGER;
BEGIN
  ---------------------------------------------------------------------------
  -- Step A. Fix Niko's last_name.
  ---------------------------------------------------------------------------

  -- Precondition: exactly one row in this org currently has the email
  -- in the last_name column.
  SELECT count(*)
    INTO v_niko_id_count
    FROM public.roster_players
   WHERE org_id     = v_org
     AND last_name  = 'Tlaiasau@icloud.com';

  IF v_niko_id_count <> 1 THEN
    RAISE EXCEPTION '[035A] expected 1 Niko row with email in last_name, found %', v_niko_id_count;
  END IF;

  UPDATE public.roster_players
     SET last_name  = 'Tlaiasau',
         updated_at = now()
   WHERE org_id     = v_org
     AND last_name  = 'Tlaiasau@icloud.com';

  GET DIAGNOSTICS v_niko_updates = ROW_COUNT;
  IF v_niko_updates <> 1 THEN
    RAISE EXCEPTION '[035A] expected to update 1 row, updated %', v_niko_updates;
  END IF;
  RAISE NOTICE '[035A] fixed Niko Tlaiasau last_name';

  ---------------------------------------------------------------------------
  -- Step B. Merge the two Lautelu (LT) rows.
  ---------------------------------------------------------------------------

  -- Precondition: both expected ids exist in this org and belong to
  -- the same kid (same first_name, same DOB).
  SELECT count(*)
    INTO v_lautelu_loser_seen
    FROM public.roster_players
   WHERE org_id    = v_org
     AND id        = v_lautelu_loser_id
     AND first_name = 'Lautelu (LT)'
     AND date_of_birth = '4/13/2017';

  SELECT count(*)
    INTO v_lautelu_winner_seen
    FROM public.roster_players
   WHERE org_id    = v_org
     AND id        = v_lautelu_winner_id
     AND first_name = 'Lautelu (LT)'
     AND date_of_birth = '4/13/2017';

  IF v_lautelu_loser_seen <> 1 OR v_lautelu_winner_seen <> 1 THEN
    RAISE EXCEPTION '[035B] expected loser/winner to each match 1 row, got loser=% winner=%',
      v_lautelu_loser_seen, v_lautelu_winner_seen;
  END IF;

  -- Merge any rich fields from the loser onto the winner. Both are
  -- expected to be thin, but doing this defensively keeps the
  -- migration safe if either row carries data we haven't inspected.
  UPDATE public.roster_players w
     SET is_age_verified     = w.is_age_verified OR l.is_age_verified,
         photo_uri            = COALESCE(NULLIF(w.photo_uri, ''),    NULLIF(l.photo_uri, '')),
         weight               = COALESCE(NULLIF(w.weight, ''),       NULLIF(l.weight, '')),
         checked_in           = w.checked_in OR l.checked_in,
         checked_in_at        = COALESCE(w.checked_in_at,            l.checked_in_at),
         parent_name          = COALESCE(NULLIF(w.parent_name, ''),  NULLIF(l.parent_name, '')),
         parent_phone         = COALESCE(NULLIF(w.parent_phone, ''), NULLIF(l.parent_phone, '')),
         restriction_status   = COALESCE(
                                  NULLIF(w.restriction_status, 'none'),
                                  NULLIF(l.restriction_status, 'none'),
                                  'none'
                                ),
         calculated_age_group = COALESCE(
                                  NULLIF(w.calculated_age_group, ''),
                                  NULLIF(l.calculated_age_group, '')
                                ),
         updated_at           = now()
    FROM public.roster_players l
   WHERE w.id = v_lautelu_winner_id
     AND l.id = v_lautelu_loser_id;

  -- Delete the loser (the row with the apostrophe).
  DELETE FROM public.roster_players
   WHERE org_id = v_org
     AND id     = v_lautelu_loser_id;

  GET DIAGNOSTICS v_lautelu_deletes = ROW_COUNT;
  IF v_lautelu_deletes <> 1 THEN
    RAISE EXCEPTION '[035B] expected to delete 1 Lautelu loser row, deleted %', v_lautelu_deletes;
  END IF;
  RAISE NOTICE '[035B] merged Lautelu (LT) Tu''ipulotu into Tuipulotu, deleted loser';

  ---------------------------------------------------------------------------
  -- Post-flight: zero rows remain in this org with email-in-last_name
  -- and zero rows with the apostrophe-spelled Lautelu.
  ---------------------------------------------------------------------------

  SELECT count(*)
    INTO v_remaining
    FROM public.roster_players
   WHERE org_id     = v_org
     AND (
           last_name = 'Tlaiasau@icloud.com'
        OR (first_name = 'Lautelu (LT)' AND last_name = 'Tu''ipulotu')
        OR (first_name = 'Lautelu (LT)' AND last_name = 'Tu’ipulotu')
     );

  IF v_remaining <> 0 THEN
    RAISE EXCEPTION '[035] post-flight: % targeted rows still present', v_remaining;
  END IF;

  RAISE NOTICE '[035] DONE: Niko fixed, Lautelu collapsed';
END
$$;

COMMIT;

-- ============================================================================
-- Verification queries (run individually, highlight + Run):
--
--   -- 1. Niko's row should now have last_name = 'Tlaiasau' (no email).
--   SELECT id, first_name, last_name, date_of_birth
--   FROM public.roster_players
--   WHERE org_id = '296fbc1a-0bec-4599-8b52-53191fb7879f'
--     AND first_name = 'Niko'
--     AND last_name ILIKE 'Tlaiasau%';
--
--   -- 2. Exactly one Lautelu (LT) row should remain, last_name='Tuipulotu'.
--   SELECT id, first_name, last_name, date_of_birth, checked_in, weight
--   FROM public.roster_players
--   WHERE org_id = '296fbc1a-0bec-4599-8b52-53191fb7879f'
--     AND first_name = 'Lautelu (LT)';
--
--   -- 3. Total roster size for the org. Should be 2131 (was 2132 post-034).
--   SELECT count(*) AS total_players
--   FROM public.roster_players
--   WHERE org_id = '296fbc1a-0bec-4599-8b52-53191fb7879f';
-- ============================================================================
