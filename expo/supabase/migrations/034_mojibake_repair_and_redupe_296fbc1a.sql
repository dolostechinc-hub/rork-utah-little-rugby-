-- 034_mojibake_repair_and_redupe_296fbc1a.sql
--
-- Pass 2 of cleanup for org 296fbc1a-0bec-4599-8b52-53191fb7879f:
-- repair UTF-8 mojibake in roster_players name fields.
--
-- Background: somewhere upstream, names containing curly quotes
-- (’, ‘, “, ”) and the Hawaiian/Samoan kahakō Ō were re-encoded
-- Latin-1-as-UTF-8, leaving sequences like:
--   â€™  -> ’    (U+2019 RIGHT SINGLE QUOTATION MARK)
--   â€˜  -> ‘    (U+2018 LEFT  SINGLE QUOTATION MARK)
--   â€œ  -> “    (U+201C LEFT  DOUBLE QUOTATION MARK)
--   â€   -> ”    (U+201D RIGHT DOUBLE QUOTATION MARK)
--   PÅ  -> Pō   (U+014C LATIN CAPITAL LETTER O WITH MACRON, partial loss)
--
-- Two operations are bundled together:
--
--   * MERGE-AND-DELETE: 8 rows whose name is mojibake AND whose org
--     already contains a clean twin (same DOB + same name modulo
--     apostrophe form). Rich fields on the mojibake row are folded
--     onto the clean twin first; the mojibake row is then deleted.
--
--   * REPAIR-IN-PLACE: 7 rows whose name is mojibake but for which no
--     clean twin exists. Their first/last/parent name fields are
--     rewritten to the proper UTF-8 form and left in the table.
--
-- Hard preconditions (any failure ROLLS BACK the entire transaction):
--   * Exactly 8 merges and 7 repairs are detected before applying. If
--     the data has drifted since the preview was taken, abort.
--   * No mojibake row has more than one twin (would be ambiguous).
--   * Post-flight: zero rows in this org still contain a mojibake
--     marker substring (â€ or PÅ) anywhere in name fields.
--
-- Idempotency: if zero mojibake rows are present (e.g. this migration
-- has already been applied successfully), the DO block exits cleanly
-- with a NOTICE and no changes.

BEGIN;

DO $$
DECLARE
  v_org                  TEXT    := '296fbc1a-0bec-4599-8b52-53191fb7879f';
  v_expected_merges      INTEGER := 8;
  v_expected_repairs     INTEGER := 7;
  v_planned_merges       INTEGER;
  v_planned_repairs      INTEGER;
  v_planned_total        INTEGER;
  v_ambiguous            INTEGER;
  v_actual_deletes       INTEGER;
  v_actual_text_updates  INTEGER;
  v_remaining_mojibake   INTEGER;
BEGIN
  -- Step 0. Build a per-row plan: cleaned name fields + twin id (if any).
  CREATE TEMP TABLE moji_plan ON COMMIT DROP AS
  WITH mojis AS (
    SELECT
      p.id,
      p.first_name,
      p.last_name,
      p.parent_name,
      p.parent_phone,
      p.photo_uri,
      p.weight,
      p.is_age_verified,
      p.checked_in,
      p.checked_in_at,
      p.restriction_status,
      p.calculated_age_group,
      p.date_of_birth,
      lower(trim(regexp_replace(
        p.first_name, 'â€™|â€˜|â€œ|â€|PÅ|[''’‘`´"]', '', 'g'
      ))) AS fn_strip,
      lower(trim(regexp_replace(
        p.last_name,  'â€™|â€˜|â€œ|â€|PÅ|[''’‘`´"]', '', 'g'
      ))) AS ln_strip
    FROM public.roster_players p
    WHERE p.org_id = v_org
      AND (
            p.first_name  ~ 'â€|PÅ'
         OR p.last_name   ~ 'â€|PÅ'
         OR p.parent_name ~ 'â€|PÅ'
      )
  )
  SELECT
    m.id           AS moji_id,
    m.first_name   AS moji_fn,
    m.last_name    AS moji_ln,
    m.parent_name  AS moji_pn,
    m.is_age_verified,
    m.photo_uri,
    m.weight,
    m.checked_in,
    m.checked_in_at,
    m.parent_phone,
    m.restriction_status,
    m.calculated_age_group,
    -- Repaired text (longest mojibake sequences first).
    regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
      m.first_name,                'PÅ',  'Pō', 'g'),
                                   'â€™', '’',  'g'),
                                   'â€˜', '‘',  'g'),
                                   'â€œ', '“',  'g'),
                                   'â€',  '”',  'g') AS fn_clean,
    regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
      m.last_name,                 'PÅ',  'Pō', 'g'),
                                   'â€™', '’',  'g'),
                                   'â€˜', '‘',  'g'),
                                   'â€œ', '“',  'g'),
                                   'â€',  '”',  'g') AS ln_clean,
    regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
      COALESCE(m.parent_name, ''), 'PÅ',  'Pō', 'g'),
                                   'â€™', '’',  'g'),
                                   'â€˜', '‘',  'g'),
                                   'â€œ', '“',  'g'),
                                   'â€',  '”',  'g') AS pn_clean,
    -- Twin id (NULL if no clean twin in this org with same DOB).
    (
      SELECT r.id
        FROM public.roster_players r
       WHERE r.org_id  = v_org
         AND r.id     <> m.id
         AND r.date_of_birth = m.date_of_birth
         AND lower(trim(regexp_replace(r.first_name, 'â€™|â€˜|â€œ|â€|PÅ|[''’‘`´"]', '', 'g'))) = m.fn_strip
         AND lower(trim(regexp_replace(r.last_name,  'â€™|â€˜|â€œ|â€|PÅ|[''’‘`´"]', '', 'g'))) = m.ln_strip
       LIMIT 1
    ) AS twin_id,
    -- Twin count (sanity check; must be 0 or 1).
    (
      SELECT count(*)
        FROM public.roster_players r
       WHERE r.org_id  = v_org
         AND r.id     <> m.id
         AND r.date_of_birth = m.date_of_birth
         AND lower(trim(regexp_replace(r.first_name, 'â€™|â€˜|â€œ|â€|PÅ|[''’‘`´"]', '', 'g'))) = m.fn_strip
         AND lower(trim(regexp_replace(r.last_name,  'â€™|â€˜|â€œ|â€|PÅ|[''’‘`´"]', '', 'g'))) = m.ln_strip
    ) AS twin_count
  FROM mojis m;

  CREATE INDEX ON moji_plan (moji_id);

  SELECT count(*) FILTER (WHERE twin_id IS NOT NULL),
         count(*) FILTER (WHERE twin_id IS NULL),
         count(*),
         count(*) FILTER (WHERE twin_count > 1)
    INTO v_planned_merges, v_planned_repairs, v_planned_total, v_ambiguous
    FROM moji_plan;

  RAISE NOTICE '[034] org=% mojibake_total=% planned_merges=% planned_repairs=% ambiguous=%',
    v_org, v_planned_total, v_planned_merges, v_planned_repairs, v_ambiguous;

  -- Idempotent early-out.
  IF v_planned_total = 0 THEN
    RAISE NOTICE '[034] no mojibake rows found; nothing to do';
    RETURN;
  END IF;

  -- Step 1. Hard preconditions.
  IF v_ambiguous <> 0 THEN
    RAISE EXCEPTION '[034] % mojibake row(s) have multiple twins; resolve manually first', v_ambiguous;
  END IF;

  IF v_planned_merges <> v_expected_merges
     OR v_planned_repairs <> v_expected_repairs THEN
    RAISE EXCEPTION '[034] precondition failed: expected %merges/%repairs but found %merges/%repairs',
      v_expected_merges, v_expected_repairs, v_planned_merges, v_planned_repairs;
  END IF;

  -- Step 2. Merge rich fields from mojibake rows onto their clean twins.
  -- Survivor is the twin (clean form). Merge rules mirror migration 033:
  --   bool fields OR; text fields prefer survivor's non-empty, fall
  --   back to mojibake row's non-empty; restriction_status prefers
  --   non-'none'; checked_in_at takes the existing value if set, else
  --   the mojibake row's value.
  UPDATE public.roster_players r
     SET is_age_verified      = r.is_age_verified OR p.is_age_verified,
         photo_uri             = COALESCE(NULLIF(r.photo_uri, ''),    NULLIF(p.photo_uri, '')),
         weight                = COALESCE(NULLIF(r.weight, ''),       NULLIF(p.weight, '')),
         checked_in            = r.checked_in OR p.checked_in,
         checked_in_at         = COALESCE(r.checked_in_at,            p.checked_in_at),
         parent_name           = COALESCE(NULLIF(r.parent_name, ''),  NULLIF(p.moji_pn, '')),
         parent_phone          = COALESCE(NULLIF(r.parent_phone, ''), NULLIF(p.parent_phone, '')),
         restriction_status    = COALESCE(
                                   NULLIF(r.restriction_status, 'none'),
                                   NULLIF(p.restriction_status, 'none'),
                                   'none'
                                 ),
         calculated_age_group  = COALESCE(
                                   NULLIF(r.calculated_age_group, ''),
                                   NULLIF(p.calculated_age_group, '')
                                 ),
         updated_at            = now()
    FROM moji_plan p
   WHERE r.id = p.twin_id
     AND p.twin_id IS NOT NULL;

  -- Step 3. Delete the mojibake rows that had twins (they're now merged).
  DELETE FROM public.roster_players r
   USING moji_plan p
   WHERE r.id = p.moji_id
     AND p.twin_id IS NOT NULL;

  GET DIAGNOSTICS v_actual_deletes = ROW_COUNT;
  IF v_actual_deletes <> v_expected_merges THEN
    RAISE EXCEPTION '[034] step 3 deleted % rows but expected %', v_actual_deletes, v_expected_merges;
  END IF;
  RAISE NOTICE '[034] merged & deleted % mojibake row(s) into clean twins', v_actual_deletes;

  -- Step 4. Repair text in-place for mojibake rows without a clean twin.
  UPDATE public.roster_players r
     SET first_name  = p.fn_clean,
         last_name   = p.ln_clean,
         parent_name = NULLIF(p.pn_clean, ''),
         updated_at  = now()
    FROM moji_plan p
   WHERE r.id = p.moji_id
     AND p.twin_id IS NULL;

  GET DIAGNOSTICS v_actual_text_updates = ROW_COUNT;
  IF v_actual_text_updates <> v_expected_repairs THEN
    RAISE EXCEPTION '[034] step 4 repaired % rows but expected %', v_actual_text_updates, v_expected_repairs;
  END IF;
  RAISE NOTICE '[034] repaired text in-place on % row(s)', v_actual_text_updates;

  -- Step 5. Post-flight: zero remaining mojibake markers in this org.
  SELECT count(*) INTO v_remaining_mojibake
    FROM public.roster_players
   WHERE org_id = v_org
     AND (
           first_name  ~ 'â€|PÅ'
        OR last_name   ~ 'â€|PÅ'
        OR parent_name ~ 'â€|PÅ'
     );

  IF v_remaining_mojibake <> 0 THEN
    RAISE EXCEPTION '[034] post-flight: % rows still contain mojibake markers', v_remaining_mojibake;
  END IF;

  RAISE NOTICE '[034] DONE: org=% merged=% repaired=% remaining_mojibake=0',
    v_org, v_actual_deletes, v_actual_text_updates;
END
$$;

COMMIT;

-- ============================================================================
-- Verification queries (read-only) you can run after applying:
--
--   -- 1. Total roster size for the org. Should drop by exactly 8
--   --    relative to the post-033 number (582 / 2140 reported earlier).
--   SELECT count(*) AS total_players,
--          count(*) FILTER (WHERE checked_in) AS checked_in_count
--   FROM public.roster_players
--   WHERE org_id = '296fbc1a-0bec-4599-8b52-53191fb7879f';
--
--   -- 2. Confirm zero remaining mojibake.
--   SELECT id, first_name, last_name, parent_name
--   FROM public.roster_players
--   WHERE org_id = '296fbc1a-0bec-4599-8b52-53191fb7879f'
--     AND (first_name ~ 'â€|PÅ' OR last_name ~ 'â€|PÅ' OR parent_name ~ 'â€|PÅ');
--
--   -- 3. Confirm the 8 clean-twin survivors now carry the formerly
--   --    mojibake'd row's rich fields.
--   SELECT id, first_name, last_name, date_of_birth,
--          is_age_verified, checked_in, weight,
--          (photo_uri IS NOT NULL AND photo_uri <> '') AS has_photo
--   FROM public.roster_players
--   WHERE id IN (
--     'imported-1777245860425-642',  -- Iokepa A’alona
--     'imported-1777245860432-1324', -- Ofa-‘I-Hevani Felila
--     'imported-1777245860424-414',  -- Lupeitu’u Mateaki
--     'imported-1777245860432-1399', -- Keli’i Sagapolutele
--     'imported-1777245860431-1230', -- Mea’Alofa Soi
--     'imported-1777245860424-436',  -- Tavita Tu’ipulotu
--     'imported-1777245860425-584',  -- Teri’i Tupua
--     'imported-1777245860428-1104'  -- Sione Tu’i Vasi
--   )
--   ORDER BY last_name, first_name;
-- ============================================================================
