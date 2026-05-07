-- 037_fix_remaining_unmatched_clubs.sql
--
-- After migration 036 added the "Little " prefix to every canonical
-- club, two roster_players rows still had unresolvable club values:
--
--   * Little Mountain Ridge Black  (1 row) -- the league merged this
--     team into Mountain Ridge in migration 025; this row escaped the
--     025 backfill, so its club still says "Mountain Ridge Black"
--     pre-036 / "Little Mountain Ridge Black" post-036.
--   * Little MVP                   (1 row) -- "MVP" is the
--     abbreviation, the canonical name is Mountain Valley Powerhouse.
--
-- Rewrite both to the correct canonical "Little ..." names. The
-- existing 025 trigger fires on each update and re-derives club_id.
--
-- Hard preconditions:
--   * Exactly 1 row each currently matches the bad names; if 0, a
--     prior run already fixed them and we abort idempotently with a
--     notice. If >1, the data has drifted and we abort loudly.
--   * Post-flight: zero rows in roster_players whose club fails to
--     resolve to a canonical clubs row.

BEGIN;

DO $$
DECLARE
  v_mrb_seen   INTEGER;
  v_mvp_seen   INTEGER;
  v_unmatched  INTEGER;
BEGIN
  SELECT count(*) INTO v_mrb_seen
    FROM public.roster_players
   WHERE club = 'Little Mountain Ridge Black';

  SELECT count(*) INTO v_mvp_seen
    FROM public.roster_players
   WHERE club = 'Little MVP';

  RAISE NOTICE '[037] before: Little Mountain Ridge Black=% Little MVP=%',
    v_mrb_seen, v_mvp_seen;

  IF v_mrb_seen = 0 AND v_mvp_seen = 0 THEN
    RAISE NOTICE '[037] no rows to fix; nothing to do';
    RETURN;
  END IF;

  IF v_mrb_seen > 1 THEN
    RAISE EXCEPTION '[037] expected 0 or 1 "Little Mountain Ridge Black" rows, found %', v_mrb_seen;
  END IF;

  IF v_mvp_seen > 1 THEN
    RAISE EXCEPTION '[037] expected 0 or 1 "Little MVP" rows, found %', v_mvp_seen;
  END IF;

  -- Verify the canonical destination rows exist (renamed by 036).
  IF NOT EXISTS (SELECT 1 FROM public.clubs WHERE name = 'Little Mountain Ridge') THEN
    RAISE EXCEPTION '[037] canonical clubs row "Little Mountain Ridge" not found -- run 036 first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.clubs WHERE name = 'Little Mountain Valley Powerhouse') THEN
    RAISE EXCEPTION '[037] canonical clubs row "Little Mountain Valley Powerhouse" not found -- run 036 first';
  END IF;

  IF v_mrb_seen = 1 THEN
    UPDATE public.roster_players
       SET club       = 'Little Mountain Ridge',
           updated_at = now()
     WHERE club       = 'Little Mountain Ridge Black';
    RAISE NOTICE '[037] rewrote "Little Mountain Ridge Black" -> "Little Mountain Ridge"';
  END IF;

  IF v_mvp_seen = 1 THEN
    UPDATE public.roster_players
       SET club       = 'Little Mountain Valley Powerhouse',
           updated_at = now()
     WHERE club       = 'Little MVP';
    RAISE NOTICE '[037] rewrote "Little MVP" -> "Little Mountain Valley Powerhouse"';
  END IF;

  -- Mirror the same fixes on public.players (older table, possibly empty).
  UPDATE public.players
     SET club = 'Little Mountain Ridge'
   WHERE club = 'Little Mountain Ridge Black';

  UPDATE public.players
     SET club = 'Little Mountain Valley Powerhouse'
   WHERE club = 'Little MVP';

  -- Post-flight: every non-empty club value in roster_players must
  -- now resolve to a canonical clubs row.
  SELECT count(*) INTO v_unmatched
    FROM public.roster_players rp
   WHERE coalesce(rp.club, '') <> ''
     AND NOT EXISTS (
       SELECT 1 FROM public.clubs c WHERE lower(c.name) = lower(rp.club)
     );

  IF v_unmatched <> 0 THEN
    RAISE EXCEPTION '[037] post-flight: % roster_players row(s) still have an unmatched club', v_unmatched;
  END IF;

  RAISE NOTICE '[037] DONE: all roster_players club values resolve to a canonical clubs row';
END
$$;

COMMIT;
