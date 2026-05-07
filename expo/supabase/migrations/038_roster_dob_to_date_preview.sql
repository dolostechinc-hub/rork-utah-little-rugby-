-- 038_roster_dob_to_date_preview.sql
--
-- READ-ONLY preview for migration 039 (text → DATE conversion of
-- public.roster_players.date_of_birth).
--
-- Returns three result sets:
--   1. Counts: total rows, parseable, blank, unparseable.
--   2. The full list of rows whose date_of_birth would NOT parse, so
--      they can be hand-fixed before running 039.
--   3. The full list of rows whose canonicalized DOB differs from the
--      raw value (i.e. would change in-place when we normalize before
--      altering the column type).
--
-- Highlight one query at a time and click "Run" to execute it.

-- ============================================================
-- 1. Counts
-- ============================================================
WITH t AS (
  SELECT
    rp.id,
    rp.date_of_birth AS raw,
    CASE
      -- YYYY-MM-DD or YYYY-M-D
      WHEN rp.date_of_birth ~ '^\s*[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}\s*$' THEN
        (regexp_match(rp.date_of_birth, '^\s*([0-9]{4})-'))[1]
        || '-' || lpad((regexp_match(rp.date_of_birth, '^\s*[0-9]{4}-([0-9]{1,2})-'))[1], 2, '0')
        || '-' || lpad((regexp_match(rp.date_of_birth, '-([0-9]{1,2})\s*$'))[1], 2, '0')
      -- M/D/YYYY or M-D-YYYY
      WHEN rp.date_of_birth ~ '^\s*[0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{4}\s*$' THEN
        (regexp_match(rp.date_of_birth, '[/-]([0-9]{4})\s*$'))[1]
        || '-' || lpad((regexp_match(rp.date_of_birth, '^\s*([0-9]{1,2})[/-]'))[1], 2, '0')
        || '-' || lpad((regexp_match(rp.date_of_birth, '^\s*[0-9]{1,2}[/-]([0-9]{1,2})[/-]'))[1], 2, '0')
      -- M/D/YY or M-D-YY  (00–29 → 2000s, 30–99 → 1900s)
      WHEN rp.date_of_birth ~ '^\s*[0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{2}\s*$' THEN
        (CASE
           WHEN (regexp_match(rp.date_of_birth, '[/-]([0-9]{2})\s*$'))[1]::int <= 29
           THEN '20' ELSE '19'
         END)
        || (regexp_match(rp.date_of_birth, '[/-]([0-9]{2})\s*$'))[1]
        || '-' || lpad((regexp_match(rp.date_of_birth, '^\s*([0-9]{1,2})[/-]'))[1], 2, '0')
        || '-' || lpad((regexp_match(rp.date_of_birth, '^\s*[0-9]{1,2}[/-]([0-9]{1,2})[/-]'))[1], 2, '0')
      ELSE NULL
    END AS canon
  FROM public.roster_players rp
)
SELECT
  count(*)                                          AS total_rows,
  count(*) FILTER (WHERE coalesce(raw,'') = '')     AS blank_rows,
  count(*) FILTER (WHERE coalesce(raw,'') <> '' AND canon IS NOT NULL) AS parseable_rows,
  count(*) FILTER (WHERE coalesce(raw,'') <> '' AND canon IS NULL)     AS unparseable_rows,
  count(*) FILTER (WHERE coalesce(raw,'') <> '' AND canon IS NOT NULL AND canon <> raw) AS rows_that_would_be_rewritten
FROM t;

-- ============================================================
-- 2. List of unparseable DOB rows (these need to be hand-fixed
--    before migration 039 will run, OR they will be set to NULL).
-- ============================================================
WITH t AS (
  SELECT
    rp.id, rp.org_id, rp.first_name, rp.last_name, rp.club, rp.team_name,
    rp.date_of_birth AS raw,
    CASE
      WHEN rp.date_of_birth ~ '^\s*[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}\s*$' THEN 'Y'
      WHEN rp.date_of_birth ~ '^\s*[0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{4}\s*$' THEN 'Y'
      WHEN rp.date_of_birth ~ '^\s*[0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{2}\s*$' THEN 'Y'
      ELSE 'N'
    END AS parses
  FROM public.roster_players rp
)
SELECT id, org_id, first_name, last_name, raw AS bad_dob, club, team_name
FROM t
WHERE coalesce(raw,'') <> '' AND parses = 'N'
ORDER BY org_id, last_name, first_name;

-- ============================================================
-- 3. List of rows where canonicalization would *change* the value
--    (e.g. '3/9/2015' → '2015-03-09'). Sanity check; you can spot
--    any unexpected rewrites before running migration 039.
-- ============================================================
WITH t AS (
  SELECT
    rp.id, rp.org_id, rp.first_name, rp.last_name,
    rp.date_of_birth AS raw,
    CASE
      WHEN rp.date_of_birth ~ '^\s*[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}\s*$' THEN
        (regexp_match(rp.date_of_birth, '^\s*([0-9]{4})-'))[1]
        || '-' || lpad((regexp_match(rp.date_of_birth, '^\s*[0-9]{4}-([0-9]{1,2})-'))[1], 2, '0')
        || '-' || lpad((regexp_match(rp.date_of_birth, '-([0-9]{1,2})\s*$'))[1], 2, '0')
      WHEN rp.date_of_birth ~ '^\s*[0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{4}\s*$' THEN
        (regexp_match(rp.date_of_birth, '[/-]([0-9]{4})\s*$'))[1]
        || '-' || lpad((regexp_match(rp.date_of_birth, '^\s*([0-9]{1,2})[/-]'))[1], 2, '0')
        || '-' || lpad((regexp_match(rp.date_of_birth, '^\s*[0-9]{1,2}[/-]([0-9]{1,2})[/-]'))[1], 2, '0')
      WHEN rp.date_of_birth ~ '^\s*[0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{2}\s*$' THEN
        (CASE
           WHEN (regexp_match(rp.date_of_birth, '[/-]([0-9]{2})\s*$'))[1]::int <= 29
           THEN '20' ELSE '19'
         END)
        || (regexp_match(rp.date_of_birth, '[/-]([0-9]{2})\s*$'))[1]
        || '-' || lpad((regexp_match(rp.date_of_birth, '^\s*([0-9]{1,2})[/-]'))[1], 2, '0')
        || '-' || lpad((regexp_match(rp.date_of_birth, '^\s*[0-9]{1,2}[/-]([0-9]{1,2})[/-]'))[1], 2, '0')
      ELSE NULL
    END AS canon
  FROM public.roster_players rp
)
SELECT id, org_id, first_name, last_name, raw, canon
FROM t
WHERE coalesce(raw,'') <> '' AND canon IS NOT NULL AND canon <> raw
ORDER BY org_id, last_name, first_name;
