-- One-off cleanup: deduplicate roster_players while preserving check-in data.
--
-- Safe to run multiple times. Does NOT change app code or require a republish.
--
-- Strategy per duplicate group (same org_id + normalized first/last name + DOB):
--   1. Pick a "winner" row to keep:
--        - prefer the row that is checked_in = TRUE
--        - then the one with a photo_uri
--        - then the one with the most recent updated_at
--   2. Merge any useful data from losers into the winner
--      (photo, weight, check-in fields, age verification) only if winner is missing it.
--   3. Delete the loser rows.
--
-- Run this in the Supabase SQL editor. Wrap in a transaction so you can ROLLBACK
-- if the preview counts look wrong.

BEGIN;

-- 1. Build a working set of duplicate groups
WITH normalized AS (
  SELECT
    id,
    org_id,
    LOWER(TRIM(first_name)) AS fn,
    LOWER(TRIM(last_name))  AS ln,
    COALESCE(NULLIF(TRIM(date_of_birth), ''), '') AS dob,
    checked_in,
    photo_uri,
    weight,
    checked_in_at,
    is_age_verified,
    updated_at
  FROM public.roster_players
),
groups AS (
  SELECT org_id, fn, ln, dob
  FROM normalized
  WHERE fn <> '' AND ln <> ''
  GROUP BY org_id, fn, ln, dob
  HAVING COUNT(*) > 1
),
ranked AS (
  SELECT
    n.*,
    ROW_NUMBER() OVER (
      PARTITION BY n.org_id, n.fn, n.ln, n.dob
      ORDER BY
        n.checked_in DESC NULLS LAST,
        (n.photo_uri IS NOT NULL) DESC,
        n.updated_at DESC NULLS LAST
    ) AS rn
  FROM normalized n
  JOIN groups g
    ON g.org_id = n.org_id
   AND g.fn     = n.fn
   AND g.ln     = n.ln
   AND g.dob    = n.dob
),
winners AS (
  SELECT * FROM ranked WHERE rn = 1
),
losers AS (
  SELECT * FROM ranked WHERE rn > 1
),
-- 2. Aggregate any salvageable data from losers per group
salvage AS (
  SELECT
    org_id, fn, ln, dob,
    BOOL_OR(checked_in)            AS any_checked_in,
    MAX(checked_in_at)             AS any_checked_in_at,
    MAX(photo_uri)                 AS any_photo_uri,
    MAX(NULLIF(weight, ''))        AS any_weight,
    BOOL_OR(is_age_verified)       AS any_age_verified
  FROM ranked
  GROUP BY org_id, fn, ln, dob
)
-- 3. Patch the winners with anything they're missing
UPDATE public.roster_players rp
SET
  checked_in       = COALESCE(NULLIF(rp.checked_in, FALSE), s.any_checked_in, rp.checked_in),
  checked_in_at    = COALESCE(rp.checked_in_at, s.any_checked_in_at),
  photo_uri        = COALESCE(rp.photo_uri, s.any_photo_uri),
  weight           = COALESCE(NULLIF(rp.weight, ''), s.any_weight, rp.weight),
  is_age_verified  = COALESCE(NULLIF(rp.is_age_verified, FALSE), s.any_age_verified, rp.is_age_verified)
FROM winners w
JOIN salvage s
  ON s.org_id = w.org_id AND s.fn = w.fn AND s.ln = w.ln AND s.dob = w.dob
WHERE rp.id = w.id;

-- 4. Preview what we are about to delete (uncomment to inspect first)
-- SELECT id, org_id, first_name, last_name, date_of_birth, club, team_name, checked_in
-- FROM public.roster_players
-- WHERE id IN (
--   SELECT r.id
--   FROM (
--     SELECT
--       id,
--       ROW_NUMBER() OVER (
--         PARTITION BY org_id, LOWER(TRIM(first_name)), LOWER(TRIM(last_name)),
--                      COALESCE(NULLIF(TRIM(date_of_birth), ''), '')
--         ORDER BY checked_in DESC NULLS LAST,
--                  (photo_uri IS NOT NULL) DESC,
--                  updated_at DESC NULLS LAST
--       ) AS rn
--     FROM public.roster_players
--     WHERE TRIM(first_name) <> '' AND TRIM(last_name) <> ''
--   ) r
--   WHERE r.rn > 1
-- );

-- 5. Delete the duplicate losers
DELETE FROM public.roster_players
WHERE id IN (
  SELECT r.id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY org_id, LOWER(TRIM(first_name)), LOWER(TRIM(last_name)),
                     COALESCE(NULLIF(TRIM(date_of_birth), ''), '')
        ORDER BY checked_in DESC NULLS LAST,
                 (photo_uri IS NOT NULL) DESC,
                 updated_at DESC NULLS LAST
      ) AS rn
    FROM public.roster_players
    WHERE TRIM(first_name) <> '' AND TRIM(last_name) <> ''
  ) r
  WHERE r.rn > 1
);

-- Review the row count, then COMMIT or ROLLBACK.
COMMIT;
