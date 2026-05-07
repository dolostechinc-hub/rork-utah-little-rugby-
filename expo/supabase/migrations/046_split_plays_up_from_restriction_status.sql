-- 046_split_plays_up_from_restriction_status.sql
--
-- The single `restriction_status` enum was conflating two orthogonal
-- decisions:
--   - "Is this kid playing in a higher age bracket than their DOB
--     would put them?"  (an AGE concern)
--   - "Does the standard weight limit apply, or are they touch-only?"
--     (a CONTACT/WEIGHT concern)
--
-- A kid can absolutely be both: e.g. play up to U14 AND register in
-- the open division (no weight limit). Today we can't represent that.
--
-- Fix: split into two columns. `plays_up` is a boolean. `restriction_status`
-- shrinks to {'none','open_division','penny_player'} -- the contact /
-- weight rule.
--
-- This migration:
--   1. Adds plays_up boolean (default false).
--   2. Backfills plays_up = true for every row currently flagged
--      restriction_status = 'play_up'. Those rows then get rewritten to
--      restriction_status = 'none' so the constraint can be tightened.
--   3. Adds a CHECK constraint that pins restriction_status to the
--      narrower domain.
--   4. Logs counts before/after for verification.
--
-- Idempotent: re-running is a no-op because the new column already
-- exists, the backfill is gated by `restriction_status = 'play_up'`
-- (which becomes empty after the first run), and the constraint add
-- is guarded.

BEGIN;

-- 1. Add plays_up if it isn't there yet.
ALTER TABLE public.roster_players
  ADD COLUMN IF NOT EXISTS plays_up boolean NOT NULL DEFAULT false;

-- 2. Diagnostic: how many rows are currently 'play_up' across all orgs?
DO $$
DECLARE
  v_play_up_rows int;
BEGIN
  SELECT count(*) INTO v_play_up_rows
  FROM public.roster_players
  WHERE restriction_status = 'play_up';
  RAISE NOTICE '[046] rows currently restriction_status=play_up: %', v_play_up_rows;
END $$;

-- 3. Backfill plays_up from the legacy enum value.
UPDATE public.roster_players
   SET plays_up   = true,
       updated_by = coalesce(updated_by, 'migration-046')
 WHERE restriction_status = 'play_up'
   AND plays_up = false;

-- 4. Rewrite restriction_status away from the legacy 'play_up' value.
--    Anyone who was 'play_up' now has plays_up=true and a separate
--    contact/weight rule of 'none' (the default). Coaches can still
--    elect open_division or penny_player on top via the modal.
UPDATE public.roster_players
   SET restriction_status = 'none',
       updated_by         = coalesce(updated_by, 'migration-046')
 WHERE restriction_status = 'play_up';

-- 5. Tighten the check constraint. Drop any prior version first so this
--    is safe to re-run / safe to apply even if a hand-rolled constraint
--    was added out of band.
ALTER TABLE public.roster_players
  DROP CONSTRAINT IF EXISTS roster_players_restriction_status_check;

ALTER TABLE public.roster_players
  ADD CONSTRAINT roster_players_restriction_status_check
  CHECK (
    restriction_status IS NULL
    OR restriction_status IN ('none','open_division','penny_player')
  );

-- 6. Verify there are no stragglers (e.g. case mismatches, NULLs that
--    snuck in via legacy imports). Raise loudly if so.
DO $$
DECLARE
  v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
  FROM public.roster_players
  WHERE restriction_status IS NOT NULL
    AND restriction_status NOT IN ('none','open_division','penny_player');
  IF v_bad > 0 THEN
    RAISE EXCEPTION
      '[046] % roster_players rows still have an out-of-domain restriction_status', v_bad;
  END IF;
END $$;

-- 7. Final summary by org so we can eyeball the new shape.
DO $$
DECLARE
  v_rec record;
BEGIN
  FOR v_rec IN
    SELECT
      org_id,
      count(*)                                         AS total,
      count(*) FILTER (WHERE plays_up)                 AS plays_up,
      count(*) FILTER (WHERE restriction_status = 'open_division') AS open_division,
      count(*) FILTER (WHERE restriction_status = 'penny_player')  AS penny_player,
      count(*) FILTER (WHERE plays_up AND restriction_status = 'open_division') AS play_up_and_open
    FROM public.roster_players
    GROUP BY org_id
    ORDER BY total DESC
  LOOP
    RAISE NOTICE
      '[046] org=% total=% plays_up=% open=% penny=% play_up_and_open=%',
      v_rec.org_id,
      v_rec.total,
      v_rec.plays_up,
      v_rec.open_division,
      v_rec.penny_player,
      v_rec.play_up_and_open;
  END LOOP;
END $$;

COMMIT;
