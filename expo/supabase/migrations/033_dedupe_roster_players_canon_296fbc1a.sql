-- 033_dedupe_roster_players_canon_296fbc1a.sql
--
-- Pass 1 of cleanup for org 296fbc1a-0bec-4599-8b52-53191fb7879f:
-- collapse roster_players rows whose date_of_birth differs only in
-- format (leading zeros, 2- vs 4-digit year) but whose canonical
-- (year, month, day) are identical.
--
-- Differs from migration 031 in two ways:
--   1. The join key uses a CANONICALIZED dob (lpad'd YYYY-MM-DD string)
--      so that '05/18/2015' and '5/18/2015' join as one cluster.
--   2. We MERGE the rich fields onto the survivor BEFORE deleting the
--      losers, because at least one cluster (phoenix afuvai) has rich
--      data on more than one row in the cluster -- migration 031's
--      delete-only logic would have lost data.
--
-- Scoped to a SINGLE org id on purpose (other orgs have already been
-- deduped by the strict-text migration 031 and we don't want to touch
-- them again here).
--
-- DOB canonicalization: pure string substitution -- no make_date, so
-- garbage values like Ryley Ruga's '15/20/2015' don't blow up. They
-- just get their own canonical string ('2015-15-20'), don't collide
-- with anything else, and are left alone by this migration.
--
-- Survivor selection (per cluster): same priorities as migration 031:
--   1. Highest rich_score (verified, photo, weight, checked_in,
--      parent_phone -- one point each).
--   2. Most-recent client_updated_at.
--   3. Most-recent updated_at.
--   4. Lexicographically smallest id (deterministic tiebreak).
--
-- Merge rules onto the survivor:
--   * is_age_verified := bool_or across the cluster (any TRUE -> TRUE).
--   * photo_uri / weight / parent_name / parent_phone / calculated_age_group:
--     keep the survivor's value if it is non-empty, else fall back to
--     the most-favoured non-empty value across the cluster.
--   * checked_in := bool_or; checked_in_at := latest non-null
--     across the cluster.
--   * restriction_status: prefer survivor's non-'none' value, else any
--     non-'none' value across the cluster, else 'none'.
--
-- Hard preconditions (any failure ROLLS BACK the entire transaction):
--   * The number of deleted rows equals the planned non-survivor count.
--   * Zero remaining canonical clusters with count(*) > 1 in this org.

BEGIN;

DO $$
DECLARE
  v_org                 TEXT := '296fbc1a-0bec-4599-8b52-53191fb7879f';
  v_clusters_initial    INTEGER;
  v_planned_deletes     INTEGER;
  v_actual_deletes      INTEGER;
  v_remaining_clusters  INTEGER;
  v_survivor_updates    INTEGER;
BEGIN
  -- Step 1. Build a per-row plan with canonical DOB and survivor rank.
  CREATE TEMP TABLE plan ON COMMIT DROP AS
  WITH canon AS (
    SELECT
      p.id,
      p.org_id,
      lower(trim(p.first_name)) AS fn_norm,
      lower(trim(p.last_name))  AS ln_norm,
      p.is_age_verified,
      p.photo_uri,
      p.weight,
      p.checked_in,
      p.checked_in_at,
      p.parent_name,
      p.parent_phone,
      p.restriction_status,
      p.calculated_age_group,
      p.client_updated_at,
      p.updated_at,
      CASE
        WHEN p.date_of_birth ~ '^\s*\d{1,2}/\d{1,2}/\d{4}\s*$' THEN
          (regexp_match(p.date_of_birth, '/(\d{4})\s*$'))[1]
          || '-' ||
          lpad((regexp_match(p.date_of_birth, '^\s*(\d{1,2})/'))[1], 2, '0')
          || '-' ||
          lpad((regexp_match(p.date_of_birth, '^\s*\d{1,2}/(\d{1,2})/'))[1], 2, '0')
        WHEN p.date_of_birth ~ '^\s*\d{1,2}/\d{1,2}/\d{2}\s*$' THEN
          CASE WHEN (regexp_match(p.date_of_birth, '/(\d{2})\s*$'))[1]::int
                    <= (extract(year from now())::int - 2000 + 1)
               THEN '20' ELSE '19' END
          || (regexp_match(p.date_of_birth, '/(\d{2})\s*$'))[1]
          || '-' ||
          lpad((regexp_match(p.date_of_birth, '^\s*(\d{1,2})/'))[1], 2, '0')
          || '-' ||
          lpad((regexp_match(p.date_of_birth, '^\s*\d{1,2}/(\d{1,2})/'))[1], 2, '0')
        ELSE NULL
      END AS dob_canon
    FROM public.roster_players p
    WHERE p.org_id = v_org
  )
  SELECT
    id,
    fn_norm,
    ln_norm,
    dob_canon,
    is_age_verified,
    photo_uri,
    weight,
    checked_in,
    checked_in_at,
    parent_name,
    parent_phone,
    restriction_status,
    calculated_age_group,
    (
      (is_age_verified)::int
      + (CASE WHEN photo_uri    IS NOT NULL AND photo_uri    <> '' THEN 1 ELSE 0 END)
      + (CASE WHEN weight       IS NOT NULL AND weight       <> '' THEN 1 ELSE 0 END)
      + (checked_in)::int
      + (CASE WHEN parent_phone IS NOT NULL AND parent_phone <> '' THEN 1 ELSE 0 END)
    ) AS rich_score,
    row_number() OVER (
      PARTITION BY fn_norm, ln_norm, dob_canon
      ORDER BY
        (
          (is_age_verified)::int
          + (CASE WHEN photo_uri    IS NOT NULL AND photo_uri    <> '' THEN 1 ELSE 0 END)
          + (CASE WHEN weight       IS NOT NULL AND weight       <> '' THEN 1 ELSE 0 END)
          + (checked_in)::int
          + (CASE WHEN parent_phone IS NOT NULL AND parent_phone <> '' THEN 1 ELSE 0 END)
        ) DESC,
        client_updated_at DESC NULLS LAST,
        updated_at        DESC NULLS LAST,
        id ASC
    ) AS rn,
    count(*) OVER (PARTITION BY fn_norm, ln_norm, dob_canon) AS cluster_size
  FROM canon
  WHERE dob_canon IS NOT NULL;

  CREATE INDEX ON plan (id);
  CREATE INDEX ON plan (fn_norm, ln_norm, dob_canon);

  SELECT count(*) FILTER (WHERE rn = 1 AND cluster_size > 1)
    INTO v_clusters_initial
    FROM plan;

  SELECT count(*) FILTER (WHERE rn > 1)
    INTO v_planned_deletes
    FROM plan;

  RAISE NOTICE '[033] org=% clusters_to_collapse=% planned_deletes=%',
    v_org, v_clusters_initial, v_planned_deletes;

  IF v_clusters_initial = 0 THEN
    RAISE NOTICE '[033] nothing to dedupe; exiting cleanly';
    RETURN;
  END IF;

  -- Step 2. Compute merged values per cluster, apply to the survivor.
  WITH cluster_merge AS (
    SELECT
      fn_norm,
      ln_norm,
      dob_canon,
      bool_or(is_age_verified)                              AS m_verified,
      (array_agg(photo_uri    ORDER BY rn) FILTER (WHERE photo_uri    IS NOT NULL AND photo_uri    <> ''))[1] AS m_photo,
      (array_agg(weight       ORDER BY rn) FILTER (WHERE weight       IS NOT NULL AND weight       <> ''))[1] AS m_weight,
      bool_or(checked_in)                                   AS m_checked_in,
      max(checked_in_at)                                    AS m_checked_in_at,
      (array_agg(parent_name  ORDER BY rn) FILTER (WHERE parent_name  IS NOT NULL AND parent_name  <> ''))[1] AS m_parent_name,
      (array_agg(parent_phone ORDER BY rn) FILTER (WHERE parent_phone IS NOT NULL AND parent_phone <> ''))[1] AS m_parent_phone,
      (array_agg(calculated_age_group ORDER BY rn) FILTER (WHERE calculated_age_group IS NOT NULL AND calculated_age_group <> ''))[1] AS m_calc_age,
      (array_agg(restriction_status
        ORDER BY CASE WHEN restriction_status IS NULL OR restriction_status = 'none' THEN 1 ELSE 0 END, rn
      ) FILTER (WHERE restriction_status IS NOT NULL))[1]   AS m_restriction
    FROM plan
    GROUP BY fn_norm, ln_norm, dob_canon
    HAVING count(*) > 1
  )
  UPDATE public.roster_players r
     SET is_age_verified      = m.m_verified,
         photo_uri             = COALESCE(NULLIF(r.photo_uri, ''),    m.m_photo),
         weight                = COALESCE(NULLIF(r.weight, ''),       m.m_weight),
         checked_in            = m.m_checked_in,
         checked_in_at         = COALESCE(r.checked_in_at,            m.m_checked_in_at),
         parent_name           = COALESCE(NULLIF(r.parent_name, ''),  m.m_parent_name),
         parent_phone          = COALESCE(NULLIF(r.parent_phone, ''), m.m_parent_phone),
         calculated_age_group  = COALESCE(NULLIF(r.calculated_age_group, ''), m.m_calc_age),
         restriction_status    = COALESCE(
                                   NULLIF(r.restriction_status, 'none'),
                                   m.m_restriction,
                                   'none'
                                 ),
         updated_at            = now()
    FROM plan p
    JOIN cluster_merge m
      ON m.fn_norm   = p.fn_norm
     AND m.ln_norm   = p.ln_norm
     AND m.dob_canon = p.dob_canon
   WHERE r.id           = p.id
     AND p.rn           = 1
     AND p.cluster_size > 1;

  GET DIAGNOSTICS v_survivor_updates = ROW_COUNT;
  RAISE NOTICE '[033] merged rich fields onto % survivor row(s)', v_survivor_updates;

  -- Step 3. Delete the non-survivors.
  DELETE FROM public.roster_players r
   USING plan p
   WHERE r.id = p.id
     AND p.rn > 1;

  GET DIAGNOSTICS v_actual_deletes = ROW_COUNT;
  RAISE NOTICE '[033] deleted % non-survivor row(s)', v_actual_deletes;

  IF v_actual_deletes <> v_planned_deletes THEN
    RAISE EXCEPTION '[033] planned % deletes but actually deleted % -- aborting',
      v_planned_deletes, v_actual_deletes;
  END IF;

  -- Step 4. Post-flight: zero canonical clusters left in this org.
  SELECT count(*) INTO v_remaining_clusters
  FROM (
    SELECT
      lower(trim(first_name)) AS fn_norm,
      lower(trim(last_name))  AS ln_norm,
      CASE
        WHEN date_of_birth ~ '^\s*\d{1,2}/\d{1,2}/\d{4}\s*$' THEN
          (regexp_match(date_of_birth, '/(\d{4})\s*$'))[1]
          || '-' ||
          lpad((regexp_match(date_of_birth, '^\s*(\d{1,2})/'))[1], 2, '0')
          || '-' ||
          lpad((regexp_match(date_of_birth, '^\s*\d{1,2}/(\d{1,2})/'))[1], 2, '0')
        WHEN date_of_birth ~ '^\s*\d{1,2}/\d{1,2}/\d{2}\s*$' THEN
          CASE WHEN (regexp_match(date_of_birth, '/(\d{2})\s*$'))[1]::int
                    <= (extract(year from now())::int - 2000 + 1)
               THEN '20' ELSE '19' END
          || (regexp_match(date_of_birth, '/(\d{2})\s*$'))[1]
          || '-' ||
          lpad((regexp_match(date_of_birth, '^\s*(\d{1,2})/'))[1], 2, '0')
          || '-' ||
          lpad((regexp_match(date_of_birth, '^\s*\d{1,2}/(\d{1,2})/'))[1], 2, '0')
        ELSE NULL
      END AS dob_canon
    FROM public.roster_players
    WHERE org_id = v_org
  ) c
  WHERE dob_canon IS NOT NULL
  GROUP BY fn_norm, ln_norm, dob_canon
  HAVING count(*) > 1;

  IF v_remaining_clusters <> 0 THEN
    RAISE EXCEPTION '[033] post-flight: % canonical clusters STILL have count(*) > 1 -- aborting',
      v_remaining_clusters;
  END IF;

  RAISE NOTICE '[033] DONE: collapsed % cluster(s), merged % survivor(s), deleted % row(s) for org %',
    v_clusters_initial, v_survivor_updates, v_actual_deletes, v_org;
END
$$;

COMMIT;

-- ============================================================================
-- Verification queries (read-only) you can run after applying:
--
--   -- 1. Total roster size for the org (should drop by exactly the
--   --    "planned_deletes" notice from the migration).
--   SELECT count(*) AS total_players,
--          count(*) FILTER (WHERE checked_in) AS checked_in_count
--   FROM public.roster_players
--   WHERE org_id = '296fbc1a-0bec-4599-8b52-53191fb7879f';
--
--   -- 2. Re-run the canonical-DOB cluster query. Should return zero rows.
--   --    (Use the same query you ran in the chat.)
-- ============================================================================
