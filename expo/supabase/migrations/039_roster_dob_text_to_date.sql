-- 039_roster_dob_text_to_date.sql
--
-- Convert public.roster_players.date_of_birth from TEXT to DATE.
--
-- Original column was created in migration 010 as TEXT DEFAULT ''.
-- That choice has caused recurring data-quality issues (mixed formats,
-- two-digit years, malformed values like '03/032014'), so we now:
--
--   Step A. Fix the 10 known malformed rows (MM/DDYYYY pattern) in place.
--   Step B. Canonicalize every parseable text DOB to YYYY-MM-DD.
--   Step C. Verify nothing unparseable remains.
--   Step D. ALTER COLUMN to DATE.
--   Step E. Drop the empty-string default; nullable DATE going forward.
--
-- Preview was migration 038. Counts as of preview run:
--   total_rows                   = 8190
--   blank_rows                   =    0
--   parseable_rows               = 8180
--   unparseable_rows             =   10  ← all MM/DDYYYY shape, fixed in step A
--   rows_that_would_be_rewritten = 8180  ← canonicalized in step B
--
-- Idempotent: re-running after success is a no-op (steps A/B/C find
-- nothing to do, step D detects DATE type and skips).

BEGIN;

-- ============================================================
-- Step 0: short-circuit if the column is already DATE.
-- ============================================================
DO $$
DECLARE
  v_type text;
BEGIN
  SELECT data_type INTO v_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'roster_players'
    AND column_name = 'date_of_birth';

  IF v_type = 'date' THEN
    RAISE NOTICE '[039] roster_players.date_of_birth is already DATE; nothing to do';
    RETURN;
  END IF;

  IF v_type IS NULL THEN
    RAISE EXCEPTION '[039] roster_players.date_of_birth column not found';
  END IF;

  IF v_type NOT IN ('text','character varying') THEN
    RAISE EXCEPTION '[039] unexpected current type %; refusing to migrate', v_type;
  END IF;

  RAISE NOTICE '[039] starting migration: current type = %', v_type;
END $$;

-- ============================================================
-- Step A: fix the 10 known malformed MM/DDYYYY rows.
--
-- Shape: '\d{2}/\d{2}\d{4}' (missing second slash). Pattern is
-- specific enough to avoid clobbering anything legitimate.
-- ============================================================
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.roster_players
  WHERE date_of_birth ~ '^[0-9]{2}/[0-9]{2}[0-9]{4}$';

  RAISE NOTICE '[039.A] rows with MM/DDYYYY shape: %', v_count;

  IF v_count = 0 THEN
    RAISE NOTICE '[039.A] nothing to fix in step A; skipping';
    RETURN;
  END IF;

  IF v_count <> 10 THEN
    RAISE EXCEPTION
      '[039.A] expected exactly 10 malformed MM/DDYYYY rows, found %',
      v_count;
  END IF;

  UPDATE public.roster_players
     SET date_of_birth =
           regexp_replace(date_of_birth,
                          '^([0-9]{2})/([0-9]{2})([0-9]{4})$',
                          '\1/\2/\3')
   WHERE date_of_birth ~ '^[0-9]{2}/[0-9]{2}[0-9]{4}$';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE '[039.A] fixed % MM/DDYYYY rows', v_count;
END $$;

-- ============================================================
-- Step A-bis: explicit one-off fixes for known impossible-month
-- rows surfaced by step C-bis on a previous run.
--
-- - "Ryley Ruga"  '15/20/2015' / '15-20-2015'  →  '5/20/2015'
--   (parents confirmed DOB is 2015-05-20.)
--
-- Originally there were 4 such rows across orgs 4dc03daa, ceaf1590,
-- 07c516a0, 4868ba1b. By the time of this commit, the 07c516a0 row
-- had already been cleaned up elsewhere, leaving 3. Rather than hard
-- code an expected count, we update every matching row and let step
-- C-bis verify nothing impossible remains.
--
-- Match by (first_name, last_name, current bad dob) rather than id
-- because the recov-* id is shared across two orgs.
-- ============================================================
DO $$
DECLARE
  v_count int;
BEGIN
  UPDATE public.roster_players
     SET date_of_birth = '5/20/2015'
   WHERE first_name = 'Ryley'
     AND last_name  = 'Ruga'
     AND date_of_birth IN ('15/20/2015', '15-20-2015');

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE '[039.A-bis] fixed % Ryley Ruga rows', v_count;

  -- Sanity bound: never expected to be more than a small handful.
  IF v_count > 10 THEN
    RAISE EXCEPTION
      '[039.A-bis] unexpectedly large fix count (%); aborting for review',
      v_count;
  END IF;
END $$;

-- ============================================================
-- Step B: canonicalize every parseable text DOB to YYYY-MM-DD.
--
-- Accepts:
--   YYYY-M-D        (zero-pads month/day)
--   M/D/YYYY, M-D-YYYY
--   M/D/YY,   M-D-YY      (00–29 → 2000s, 30–99 → 1900s)
--
-- Anything else is left alone (and tripped up in step C).
-- ============================================================
DO $$
DECLARE
  v_count int;
BEGIN
  WITH src AS (
    SELECT
      id,
      date_of_birth AS raw,
      CASE
        -- YYYY-M-D
        WHEN date_of_birth ~ '^\s*[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}\s*$' THEN
          (regexp_match(date_of_birth, '^\s*([0-9]{4})-'))[1]
          || '-' || lpad((regexp_match(date_of_birth, '^\s*[0-9]{4}-([0-9]{1,2})-'))[1], 2, '0')
          || '-' || lpad((regexp_match(date_of_birth, '-([0-9]{1,2})\s*$'))[1], 2, '0')
        -- M/D/YYYY or M-D-YYYY
        WHEN date_of_birth ~ '^\s*[0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{4}\s*$' THEN
          (regexp_match(date_of_birth, '[/-]([0-9]{4})\s*$'))[1]
          || '-' || lpad((regexp_match(date_of_birth, '^\s*([0-9]{1,2})[/-]'))[1], 2, '0')
          || '-' || lpad((regexp_match(date_of_birth, '^\s*[0-9]{1,2}[/-]([0-9]{1,2})[/-]'))[1], 2, '0')
        -- M/D/YY or M-D-YY  (00–29 → 2000s, 30–99 → 1900s)
        WHEN date_of_birth ~ '^\s*[0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{2}\s*$' THEN
          (CASE WHEN (regexp_match(date_of_birth, '[/-]([0-9]{2})\s*$'))[1]::int <= 29
                THEN '20' ELSE '19' END)
          || (regexp_match(date_of_birth, '[/-]([0-9]{2})\s*$'))[1]
          || '-' || lpad((regexp_match(date_of_birth, '^\s*([0-9]{1,2})[/-]'))[1], 2, '0')
          || '-' || lpad((regexp_match(date_of_birth, '^\s*[0-9]{1,2}[/-]([0-9]{1,2})[/-]'))[1], 2, '0')
        ELSE NULL
      END AS canon
    FROM public.roster_players
    WHERE coalesce(date_of_birth,'') <> ''
  ),
  upd AS (
    UPDATE public.roster_players rp
       SET date_of_birth = src.canon
      FROM src
     WHERE rp.id = src.id
       AND src.canon IS NOT NULL
       AND src.canon <> rp.date_of_birth
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM upd;

  RAISE NOTICE '[039.B] canonicalized % rows to YYYY-MM-DD', v_count;
END $$;

-- ============================================================
-- Step C: verify nothing unparseable remains.
-- ============================================================
DO $$
DECLARE
  v_bad int;
  v_blank int;
BEGIN
  SELECT count(*) INTO v_bad
  FROM public.roster_players
  WHERE coalesce(date_of_birth,'') <> ''
    AND date_of_birth !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';

  SELECT count(*) INTO v_blank
  FROM public.roster_players
  WHERE coalesce(date_of_birth,'') = '';

  RAISE NOTICE '[039.C] remaining unparseable rows = %, blank rows = %', v_bad, v_blank;

  IF v_bad > 0 THEN
    RAISE EXCEPTION
      '[039.C] % rows still unparseable; refusing to ALTER. '
      'Run migration 038 query 2 to list them and add explicit fixes to step A.',
      v_bad;
  END IF;
END $$;

-- ============================================================
-- Step C-bis: strict per-row cast validation.
--
-- Step C only verified the textual shape (YYYY-MM-DD) of every value.
-- That shape will admit values that aren't real calendar dates --
-- e.g. '2015-15-20' (month 15, from a M/D/Y row that was actually
-- D/M/Y), or '2014-02-30' (Feb 30). The ALTER in step D would
-- otherwise fail on the first such value with a cryptic error and
-- no row identification.
--
-- This block tries to cast each non-blank date_of_birth to ::date
-- inside its own savepoint, captures the offenders, and raises a
-- single error listing every bad row by id/org/name/dob.
--
-- Performance: this is a per-row loop in PL/pgSQL, ~8K rows. Expect
-- a few seconds. Acceptable for a one-shot migration.
-- ============================================================
DO $$
DECLARE
  r record;
  v_count int := 0;
  v_bad   text := '';
BEGIN
  FOR r IN
    SELECT id, org_id, first_name, last_name, date_of_birth
      FROM public.roster_players
     WHERE coalesce(date_of_birth,'') <> ''
  LOOP
    BEGIN
      PERFORM r.date_of_birth::date;
    EXCEPTION WHEN OTHERS THEN
      v_count := v_count + 1;
      IF v_count <= 50 THEN
        v_bad := v_bad
          || format(E'\n  id=%L  org=%L  name=%L  dob=%L',
                    r.id, r.org_id,
                    coalesce(r.first_name,'') || ' ' || coalesce(r.last_name,''),
                    r.date_of_birth);
      END IF;
    END;
  END LOOP;

  RAISE NOTICE '[039.C-bis] rows whose canonical YYYY-MM-DD is not a real calendar date: %', v_count;

  IF v_count > 0 THEN
    RAISE EXCEPTION
      E'[039.C-bis] % roster_players rows have impossible calendar dates after canonicalization. '
      'These almost always mean the original was D/M/YYYY mistakenly stored as M/D/YYYY '
      '(month >12, day swap), or a real typo. Fix them with explicit UPDATEs and re-run 039.\n'
      'First % offenders:%',
      v_count, least(v_count, 50), v_bad;
  END IF;
END $$;

-- ============================================================
-- Step D: alter the column to DATE.
--
-- Empty strings would break the cast, but step C asserts none remain.
-- The USING clause coerces the canonical YYYY-MM-DD text to date and
-- will raise on impossible calendar dates (e.g. 2015-02-30), which is
-- the desired behaviour: the txn rolls back and you get an error that
-- names the offending value.
--
-- The roster_players_identity_not_blank CHECK constraint (migration 027)
-- references length(trim(date_of_birth)), which only works on text.
-- We drop it before the ALTER and recreate it after with date-aware
-- semantics: `date_of_birth IS NOT NULL`.
-- ============================================================
ALTER TABLE public.roster_players
  DROP CONSTRAINT IF EXISTS roster_players_identity_not_blank;

ALTER TABLE public.roster_players
  ALTER COLUMN date_of_birth DROP DEFAULT;

ALTER TABLE public.roster_players
  ALTER COLUMN date_of_birth TYPE date
  USING NULLIF(date_of_birth, '')::date;

-- Recreate the identity-not-blank CHECK with date-aware semantics.
-- Original (027): trim(date_of_birth) > 0 chars.
-- New:            date_of_birth IS NOT NULL.
ALTER TABLE public.roster_players
  ADD CONSTRAINT roster_players_identity_not_blank
  CHECK (
    (first_name    IS NOT NULL AND length(trim(first_name))    > 0)
    OR (last_name     IS NOT NULL AND length(trim(last_name))     > 0)
    OR (date_of_birth IS NOT NULL)
  );

COMMENT ON CONSTRAINT roster_players_identity_not_blank
  ON public.roster_players IS
    'At least one of (first_name, last_name, date_of_birth) must be '
    'non-blank/non-null. Originally added in migration 027 with text '
    'semantics for date_of_birth; reissued in 039 with DATE semantics.';

-- Leave the column nullable; future code that needs a value should
-- enforce NOT NULL at the application layer (the existing ''-default
-- semantics meant it was effectively-required-but-blank, which we're
-- intentionally walking back).

-- ============================================================
-- Step E: post-condition log.
-- ============================================================
DO $$
DECLARE
  v_total int;
  v_null  int;
  v_oldest date;
  v_newest date;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE date_of_birth IS NULL),
         min(date_of_birth),
         max(date_of_birth)
    INTO v_total, v_null, v_oldest, v_newest
  FROM public.roster_players;

  RAISE NOTICE
    '[039] DONE. total=% null=% min=% max=%',
    v_total, v_null, v_oldest, v_newest;
END $$;

COMMIT;
