-- 042_mark_carried_over_kids_checked_in.sql
--
-- For the new org 553f476b-d0f1-4f3c-aa63-90bc3be42d36 ('2026 ULR
-- Summer 7's'), mark every roster row that has BOTH a photo_uri and
-- a non-blank weight as checked_in = true. The presence of these two
-- fields means the kid already completed pre-event registration in
-- a prior org and we don't need to re-verify them.
--
-- Carries over from migration 041, which seeded the new org but left
-- every row at checked_in = false.
--
-- checked_in_at: roster_players.checked_in_at is TEXT (legacy schema
-- decision; see migration 010), so we store a stable ISO-8601 string
-- ("2026-05-06T22:23:00Z" shape) rather than a timestamp value.
--
-- Idempotent: only flips rows that are currently NOT checked in. A
-- second run is a no-op for rows already updated by the first.

BEGIN;

DO $$
DECLARE
  v_eligible int;
  v_updated int;
BEGIN
  SELECT count(*)
    INTO v_eligible
  FROM public.roster_players
  WHERE org_id = '553f476b-d0f1-4f3c-aa63-90bc3be42d36'
    AND photo_uri IS NOT NULL
    AND photo_uri <> ''
    AND coalesce(weight, '') <> '';

  RAISE NOTICE '[042] eligible rows (photo + weight): %', v_eligible;

  UPDATE public.roster_players
     SET checked_in    = true,
         checked_in_at = to_char(now() AT TIME ZONE 'UTC',
                                 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
         updated_by    = coalesce(updated_by, 'migration-042')
   WHERE org_id = '553f476b-d0f1-4f3c-aa63-90bc3be42d36'
     AND photo_uri IS NOT NULL
     AND photo_uri <> ''
     AND coalesce(weight, '') <> ''
     AND checked_in = false;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE '[042] flipped % rows to checked_in=true', v_updated;
END $$;

-- Sanity log of the new state.
DO $$
DECLARE
  v_total int;
  v_checked int;
  v_with_photo int;
  v_with_weight int;
  v_photo_no_weight int;
  v_weight_no_photo int;
BEGIN
  SELECT
    count(*),
    count(*) FILTER (WHERE checked_in),
    count(*) FILTER (WHERE photo_uri IS NOT NULL AND photo_uri <> ''),
    count(*) FILTER (WHERE coalesce(weight,'') <> ''),
    count(*) FILTER (WHERE photo_uri IS NOT NULL AND photo_uri <> ''
                          AND coalesce(weight,'') = ''),
    count(*) FILTER (WHERE (photo_uri IS NULL OR photo_uri = '')
                          AND coalesce(weight,'') <> '')
    INTO v_total, v_checked, v_with_photo, v_with_weight,
         v_photo_no_weight, v_weight_no_photo
  FROM public.roster_players
  WHERE org_id = '553f476b-d0f1-4f3c-aa63-90bc3be42d36';

  RAISE NOTICE
    '[042] new state: total=% checked_in=% with_photo=% with_weight=% photo_only=% weight_only=%',
    v_total, v_checked, v_with_photo, v_with_weight,
    v_photo_no_weight, v_weight_no_photo;
END $$;

COMMIT;
