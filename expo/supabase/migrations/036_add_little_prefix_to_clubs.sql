-- 036_add_little_prefix_to_clubs.sql
--
-- Reverses the "Little prefix dropped" decision from migration 025
-- (Q&A 2026-05-04) at the league's request: every canonical club in
-- public.clubs is now an exclusively-youth entity, so the league wants
-- the "Little " prefix to appear on every name. Senior teams are NOT
-- in this database; the prefix is purely a labelling clarification.
--
-- What changes (atomically, in one transaction):
--   1. public.clubs.name              → 'Little ' || name       for every row
--   2. public.roster_players.club     → 'Little ' || club       for every row
--   3. public.players.club            → 'Little ' || club       for every row
--
-- What does NOT change:
--   * Any *.club_id column. clubs.id is unchanged, so existing FK
--     pointers stay valid; the rename is purely textual.
--   * roster_players.team_name / event_teams.team_name. Those are team
--     names like "U10 Brighton", not club names; the user did not ask
--     to touch them, and their format isn't consistent enough to
--     transform mechanically. If the league wants those updated, that
--     is a separate, scoped migration.
--   * roster_players.club / players.club rows that are NULL or empty.
--     Adding a "Little " prefix to an empty club name would invent a
--     value where none was set.
--
-- Behaviour of the existing roster_players club-derive trigger
-- (migration 025): when roster_players.club is updated to "Little X",
-- the trigger looks up clubs WHERE lower(name) = lower(NEW.club) — i.e.
-- it expects the club row to ALREADY have the new "Little X" name. The
-- transaction therefore renames clubs FIRST, then roster_players, then
-- players. Inside one transaction the trigger sees the renamed clubs
-- row and the FK lookup succeeds with the same id it had before.
--
-- Hard preconditions (any failure ROLLS BACK the entire transaction):
--   * Zero rows in public.clubs currently have a name starting with
--     'Little '. (Re-running this migration is therefore a loud
--     failure, never a silent double-prefix.)
--   * After the rename, every roster_players row that had a non-NULL
--     club_id before still has a non-NULL club_id pointing to the
--     SAME id.  Same invariant for public.players.
--
-- Idempotency: NOT idempotent. Re-running aborts at the precondition
-- check (no rows to rename). Use a NEW migration to make additional
-- name changes after this lands.

BEGIN;

-- ---------------------------------------------------------------------------
-- Pre-step: heal public.clubs schema drift.
-- ---------------------------------------------------------------------------
-- Some live environments were created before migration 025's CREATE TABLE
-- IF NOT EXISTS could effectively widen the schema, so the table exists
-- but is missing the columns the 025 trigger references. The 025
-- BEFORE-UPDATE trigger trg_clubs_touch tries to set NEW.updated_at,
-- which raises "record NEW has no field updated_at" if the column
-- isn't there. Add the missing columns up front so the rest of this
-- migration (and the existing trigger) can run.
-- ---------------------------------------------------------------------------

ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS short_name TEXT;
ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS is_active  BOOLEAN     NOT NULL DEFAULT TRUE;
ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
DECLARE
  v_already_prefixed_clubs    INTEGER;
  v_clubs_total               INTEGER;
  v_clubs_renamed             INTEGER;

  v_roster_with_club_before   INTEGER;
  v_roster_with_club_after    INTEGER;
  v_roster_to_rename          INTEGER;
  v_roster_already_prefixed   INTEGER;
  v_roster_clubid_before      INTEGER;
  v_roster_clubid_after       INTEGER;
  v_roster_renamed            INTEGER;
  v_roster_touched            INTEGER;

  v_players_with_club_before  INTEGER;
  v_players_with_club_after   INTEGER;
  v_players_to_rename         INTEGER;
  v_players_already_prefixed  INTEGER;
  v_players_clubid_before     INTEGER;
  v_players_clubid_after      INTEGER;
  v_players_renamed           INTEGER;
  v_players_touched           INTEGER;
BEGIN
  ---------------------------------------------------------------------------
  -- Step 0. Hard precondition: no club is currently "Little"-prefixed.
  ---------------------------------------------------------------------------

  SELECT count(*) INTO v_already_prefixed_clubs
    FROM public.clubs
   WHERE name LIKE 'Little %';

  IF v_already_prefixed_clubs > 0 THEN
    RAISE EXCEPTION
      '[036] aborting: % clubs already start with "Little " — has this migration already run?',
      v_already_prefixed_clubs;
  END IF;

  -- Capture before-counts for postcondition checks.
  SELECT count(*) INTO v_clubs_total
    FROM public.clubs;

  -- For roster_players: count separately the rows we'll rename and the
  -- rows that already have the "Little " prefix (typically because they
  -- were inserted after migration 025 with a non-canonical club name
  -- and therefore couldn't resolve to a canonical clubs row -- so
  -- their club_id is NULL). After the rename, those orphaned rows
  -- should now find a match in the renamed clubs table; we'll touch
  -- them with a no-op UPDATE to fire the derive trigger and recover
  -- their club_id.
  SELECT count(*) FILTER (WHERE coalesce(club, '') <> ''),
         count(*) FILTER (WHERE coalesce(club, '') <> '' AND club NOT LIKE 'Little %'),
         count(*) FILTER (WHERE club LIKE 'Little %'),
         count(*) FILTER (WHERE club_id IS NOT NULL)
    INTO v_roster_with_club_before,
         v_roster_to_rename,
         v_roster_already_prefixed,
         v_roster_clubid_before
    FROM public.roster_players;

  SELECT count(*) FILTER (WHERE coalesce(club, '') <> ''),
         count(*) FILTER (WHERE coalesce(club, '') <> '' AND club NOT LIKE 'Little %'),
         count(*) FILTER (WHERE club LIKE 'Little %'),
         count(*) FILTER (WHERE club_id IS NOT NULL)
    INTO v_players_with_club_before,
         v_players_to_rename,
         v_players_already_prefixed,
         v_players_clubid_before
    FROM public.players;

  RAISE NOTICE
    '[036] before: clubs=% roster(with_club=% to_rename=% already_prefixed=% with_club_id=%) players(with_club=% to_rename=% already_prefixed=% with_club_id=%)',
    v_clubs_total,
    v_roster_with_club_before, v_roster_to_rename, v_roster_already_prefixed, v_roster_clubid_before,
    v_players_with_club_before, v_players_to_rename, v_players_already_prefixed, v_players_clubid_before;

  ---------------------------------------------------------------------------
  -- Step 1. Rename canonical clubs first. The roster/player trigger that
  --         re-derives club_id from .club expects the canonical row
  --         lookup to already match the new name when those tables are
  --         updated below.
  ---------------------------------------------------------------------------

  -- Note: we deliberately do NOT touch updated_at here. The live
  -- public.clubs schema in some environments predates migration 025
  -- and is missing that column. If it exists, the BEFORE UPDATE
  -- trigger trg_clubs_touch already keeps it current.
  UPDATE public.clubs
     SET name = 'Little ' || name;

  GET DIAGNOSTICS v_clubs_renamed = ROW_COUNT;
  IF v_clubs_renamed <> v_clubs_total THEN
    RAISE EXCEPTION '[036] expected to rename % clubs, renamed %',
      v_clubs_total, v_clubs_renamed;
  END IF;
  RAISE NOTICE '[036] renamed % club row(s)', v_clubs_renamed;

  ---------------------------------------------------------------------------
  -- Step 2. Rename roster_players.club for every row that has a
  --         non-empty club value. (The BEFORE UPDATE trigger fires per
  --         row and re-derives club_id from the new "Little X" name,
  --         which now exists in clubs after Step 1.)
  ---------------------------------------------------------------------------

  UPDATE public.roster_players
     SET club       = 'Little ' || club,
         updated_at = now()
   WHERE coalesce(club, '') <> ''
     AND club NOT LIKE 'Little %';

  GET DIAGNOSTICS v_roster_renamed = ROW_COUNT;
  IF v_roster_renamed <> v_roster_to_rename THEN
    RAISE EXCEPTION
      '[036] roster_players: expected to rename % rows, renamed %',
      v_roster_to_rename, v_roster_renamed;
  END IF;
  RAISE NOTICE '[036] renamed % roster_players club value(s)', v_roster_renamed;

  -- Touch any rows that were already "Little"-prefixed but had a NULL
  -- club_id (orphans from before this migration). Setting club = club
  -- fires the derive trigger from 025, which now finds a match in the
  -- renamed clubs table and recovers their club_id. No-op for rows
  -- whose club_id is already non-NULL, but we touch them all to keep
  -- the logic simple.
  UPDATE public.roster_players
     SET club       = club,
         updated_at = now()
   WHERE club LIKE 'Little %';

  GET DIAGNOSTICS v_roster_touched = ROW_COUNT;
  RAISE NOTICE '[036] touched % roster_players row(s) to re-derive club_id', v_roster_touched;

  ---------------------------------------------------------------------------
  -- Step 3. Same for players.club (the older, server-side players table).
  ---------------------------------------------------------------------------

  UPDATE public.players
     SET club = 'Little ' || club
   WHERE coalesce(club, '') <> ''
     AND club NOT LIKE 'Little %';

  GET DIAGNOSTICS v_players_renamed = ROW_COUNT;
  IF v_players_renamed <> v_players_to_rename THEN
    RAISE EXCEPTION
      '[036] players: expected to rename % rows, renamed %',
      v_players_to_rename, v_players_renamed;
  END IF;
  RAISE NOTICE '[036] renamed % players club value(s)', v_players_renamed;

  -- Same orphan-recovery touch on the players table.
  UPDATE public.players
     SET club = club
   WHERE club LIKE 'Little %';

  GET DIAGNOSTICS v_players_touched = ROW_COUNT;
  RAISE NOTICE '[036] touched % players row(s) to re-derive club_id', v_players_touched;

  ---------------------------------------------------------------------------
  -- Step 4. Postconditions.
  ---------------------------------------------------------------------------

  -- 4a. Every club row now starts with "Little ".
  IF EXISTS (
    SELECT 1 FROM public.clubs WHERE name NOT LIKE 'Little %'
  ) THEN
    RAISE EXCEPTION '[036] post-flight: at least one club still has no "Little " prefix';
  END IF;

  -- 4b. roster_players: same number of rows still have a non-empty
  --     club AND the same number still have a non-NULL club_id. The
  --     latter is the critical invariant — it confirms the trigger
  --     successfully re-derived club_id with the new names.
  SELECT count(*) FILTER (WHERE coalesce(club, '') <> ''),
         count(*) FILTER (WHERE club_id IS NOT NULL)
    INTO v_roster_with_club_after, v_roster_clubid_after
    FROM public.roster_players;

  IF v_roster_with_club_after <> v_roster_with_club_before THEN
    RAISE EXCEPTION
      '[036] roster_players club-text count drifted: before=% after=%',
      v_roster_with_club_before, v_roster_with_club_after;
  END IF;
  -- club_id count is only allowed to stay the same or INCREASE (we may
  -- have recovered orphan rows whose text was already Little-prefixed
  -- but couldn't resolve to a canonical id before this migration). A
  -- DECREASE means the rename broke a previously-valid mapping.
  IF v_roster_clubid_after < v_roster_clubid_before THEN
    RAISE EXCEPTION
      '[036] roster_players club_id count regressed: before=% after=% -- trigger failed to re-derive on at least one row',
      v_roster_clubid_before, v_roster_clubid_after;
  END IF;

  -- 4c. Same invariants for players.
  SELECT count(*) FILTER (WHERE coalesce(club, '') <> ''),
         count(*) FILTER (WHERE club_id IS NOT NULL)
    INTO v_players_with_club_after, v_players_clubid_after
    FROM public.players;

  IF v_players_with_club_after <> v_players_with_club_before THEN
    RAISE EXCEPTION
      '[036] players club-text count drifted: before=% after=%',
      v_players_with_club_before, v_players_with_club_after;
  END IF;
  IF v_players_clubid_after < v_players_clubid_before THEN
    RAISE EXCEPTION
      '[036] players club_id count regressed: before=% after=% -- trigger failed to re-derive on at least one row',
      v_players_clubid_before, v_players_clubid_after;
  END IF;

  RAISE NOTICE
    '[036] DONE: clubs_renamed=% roster(renamed=% touched=% club_id_before=% after=%) players(renamed=% touched=% club_id_before=% after=%)',
    v_clubs_renamed,
    v_roster_renamed, v_roster_touched, v_roster_clubid_before, v_roster_clubid_after,
    v_players_renamed, v_players_touched, v_players_clubid_before, v_players_clubid_after;
END
$$;

COMMIT;

-- ============================================================================
-- Verification queries (read-only):
--
--   -- 1. All canonical clubs now Little-prefixed.
--   SELECT name FROM public.clubs ORDER BY name;
--   -- expected: every row begins with "Little ".
--
--   -- 2. roster_players.club values match clubs.name 1:1 (no orphans).
--   SELECT count(*) AS unmatched_roster_clubs
--   FROM public.roster_players rp
--   WHERE coalesce(rp.club, '') <> ''
--     AND NOT EXISTS (
--       SELECT 1 FROM public.clubs c WHERE lower(c.name) = lower(rp.club)
--     );
--   -- expected: 0
--
--   -- 3. Same check on players.
--   SELECT count(*) AS unmatched_players_clubs
--   FROM public.players p
--   WHERE coalesce(p.club, '') <> ''
--     AND NOT EXISTS (
--       SELECT 1 FROM public.clubs c WHERE lower(c.name) = lower(p.club)
--     );
--   -- expected: 0
--
--   -- 4. roster_players grouped by club for spot-check.
--   SELECT club, count(*) AS players
--   FROM public.roster_players
--   WHERE coalesce(club, '') <> ''
--   GROUP BY club
--   ORDER BY club;
-- ============================================================================
