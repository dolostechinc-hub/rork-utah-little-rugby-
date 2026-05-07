-- 031_dedupe_roster_players.sql
--
-- Removes within-org duplicate roster_players rows where two or more rows
-- share (org_id, lower(trim(first_name)), lower(trim(last_name)),
-- date_of_birth) and only ONE of them should survive.
--
-- AUDIT FINDINGS (2026-05-06) JUSTIFYING THIS MIGRATION:
--   * Single affected org: 4dc03daa-0276-4c64-b230-6221677ed65f
--   * 33 duplicate clusters (32 pairs + 1 quad + 1 triple)
--   * 36 removable rows total
--   * 0 rows in those clusters carry any rich data (photo_uri, weight,
--     is_age_verified, checked_in, parent_name, parent_phone). So the
--     merge-before-delete logic from migration 029 is unnecessary --
--     every cluster is just literal duplication of the same blank
--     placeholder shell.
--
-- This migration is org-AGNOSTIC, not org-scoped: it dedupes any cluster
-- that matches the join key, regardless of which org it lives in. That
-- means it is also safe to run again later if more duplicates accrete
-- (e.g. from a future bulk import). The hard precondition below means
-- it will REFUSE to run if a future cluster contains rich data on a
-- row that would be deleted -- in that case, switch to a 029-style
-- merge-then-delete migration instead.
--
-- SURVIVOR SELECTION:
--   Within each cluster, the survivor is picked by:
--     1. Highest "rich score" (sum of: is_age_verified, photo_uri set,
--        weight set, checked_in, parent_phone set). Today every score
--        is 0, but this guarantees that if rich data ever appears it
--        is preferentially KEPT.
--     2. Most-recent client_updated_at (NULLS LAST).
--     3. Most-recent updated_at (NULLS LAST).
--     4. Lexically smallest id, as a deterministic tiebreaker so two
--        runs converge on the same survivor.
--
-- HARD PRECONDITIONS (any failure aborts the entire transaction):
--   * No non-survivor row carries any rich field. Otherwise we could
--     destroy a photo, a weight, an age verification, or a check-in.
--   * The number of rows actually deleted equals the pre-flight count
--     of non-survivor rows. Otherwise the join key disagreed with
--     itself between the two passes (which would indicate a concurrent
--     write while the migration is running).
--   * Zero remaining clusters with count(*) > 1 after the delete.

BEGIN;

DO $$
DECLARE
  v_clusters             INTEGER;
  v_total_in_clusters    INTEGER;
  v_planned_deletes      INTEGER;
  v_rich_at_risk         INTEGER;
  v_actual_deletes       INTEGER;
  v_remaining_clusters   INTEGER;
  v_affected_orgs        INTEGER;
BEGIN
  -- Materialise the cluster ranking once into a TEMP TABLE so the
  -- pre-flight checks, the DELETE, and the post-flight checks all see
  -- exactly the same row partitioning. Without this the planner is
  -- free to re-evaluate ROW_NUMBER() between calls and pick a different
  -- survivor in each pass. (TEMP tables are session-scoped and live
  -- for the duration of this transaction.)
  CREATE TEMP TABLE _roster_dedupe_plan ON COMMIT DROP AS
  SELECT
    rp.org_id,
    rp.id,
    rp.first_name,
    rp.last_name,
    rp.date_of_birth,
    rp.photo_uri,
    rp.weight,
    rp.is_age_verified,
    rp.checked_in,
    rp.parent_name,
    rp.parent_phone,
    -- "Rich score": higher = more important to keep
    (
      (CASE WHEN coalesce(rp.is_age_verified,false)                                   THEN 1 ELSE 0 END)
      + (CASE WHEN rp.photo_uri    IS NOT NULL AND rp.photo_uri    <> ''              THEN 1 ELSE 0 END)
      + (CASE WHEN rp.weight       IS NOT NULL AND rp.weight       <> ''              THEN 1 ELSE 0 END)
      + (CASE WHEN coalesce(rp.checked_in,false)                                      THEN 1 ELSE 0 END)
      + (CASE WHEN rp.parent_phone IS NOT NULL AND rp.parent_phone <> ''              THEN 1 ELSE 0 END)
    ) AS rich_score,
    -- "Has any rich data at all?" -- used for the hard precondition.
    (
      coalesce(rp.is_age_verified,false)
      OR (rp.photo_uri    IS NOT NULL AND rp.photo_uri    <> '')
      OR (rp.weight       IS NOT NULL AND rp.weight       <> '')
      OR coalesce(rp.checked_in,false)
      OR (rp.parent_name  IS NOT NULL AND rp.parent_name  <> '')
      OR (rp.parent_phone IS NOT NULL AND rp.parent_phone <> '')
    ) AS is_rich,
    ROW_NUMBER() OVER (
      PARTITION BY
        rp.org_id,
        lower(trim(coalesce(rp.first_name,''))),
        lower(trim(coalesce(rp.last_name,''))),
        coalesce(rp.date_of_birth,'')
      ORDER BY
        (
          (CASE WHEN coalesce(rp.is_age_verified,false)                                THEN 1 ELSE 0 END)
          + (CASE WHEN rp.photo_uri    IS NOT NULL AND rp.photo_uri    <> ''           THEN 1 ELSE 0 END)
          + (CASE WHEN rp.weight       IS NOT NULL AND rp.weight       <> ''           THEN 1 ELSE 0 END)
          + (CASE WHEN coalesce(rp.checked_in,false)                                   THEN 1 ELSE 0 END)
          + (CASE WHEN rp.parent_phone IS NOT NULL AND rp.parent_phone <> ''           THEN 1 ELSE 0 END)
        ) DESC,
        rp.client_updated_at DESC NULLS LAST,
        rp.updated_at        DESC NULLS LAST,
        rp.id ASC
    ) AS rn,
    COUNT(*) OVER (
      PARTITION BY
        rp.org_id,
        lower(trim(coalesce(rp.first_name,''))),
        lower(trim(coalesce(rp.last_name,''))),
        coalesce(rp.date_of_birth,'')
    ) AS cluster_size
  FROM public.roster_players rp
  -- Skip rows that don't have enough identity fields to cluster on.
  -- A blank-name row pretending to be a duplicate of another blank-name
  -- row is almost certainly NOT actually the same player.
  WHERE coalesce(rp.first_name,'') <> ''
    AND coalesce(rp.last_name,'')  <> ''
    AND coalesce(rp.date_of_birth,'') <> '';

  -- Pre-flight: cluster + delete shape.
  SELECT
    count(*) FILTER (WHERE rn = 1 AND cluster_size > 1),
    count(*)  FILTER (WHERE cluster_size > 1),
    count(*)  FILTER (WHERE rn > 1),
    count(DISTINCT org_id) FILTER (WHERE cluster_size > 1)
  INTO v_clusters, v_total_in_clusters, v_planned_deletes, v_affected_orgs
  FROM _roster_dedupe_plan;

  -- Pre-flight: how many non-survivor rows still carry rich data?
  -- Today this should be 0 (Q4 confirmed). If a future run sees > 0,
  -- the operator MUST switch to a 029-style merge-then-delete; we will
  -- not silently destroy photos / weights / age verifications.
  SELECT count(*) INTO v_rich_at_risk
  FROM _roster_dedupe_plan
  WHERE rn > 1 AND is_rich;

  RAISE NOTICE 'Roster dedupe plan: % clusters across % orgs, % total rows in clusters, % rows queued for deletion, % rich rows at risk.',
    v_clusters, v_affected_orgs, v_total_in_clusters, v_planned_deletes, v_rich_at_risk;

  IF v_rich_at_risk > 0 THEN
    RAISE EXCEPTION
      'Refusing to dedupe: % non-survivor row(s) carry rich data (photo / weight / verification / check-in / parent contact). '
      'Inspect with: SELECT * FROM _roster_dedupe_plan WHERE rn > 1 AND is_rich; '
      'then write a merge-then-delete migration following the pattern of 029_cleanup_orphan_orgs.sql.',
      v_rich_at_risk;
  END IF;

  IF v_planned_deletes = 0 THEN
    RAISE NOTICE 'No duplicate rows to delete. Migration is a no-op.';
    RETURN;
  END IF;

  -- Apply the delete. The composite PK on (org_id, id) means we have
  -- to match on both columns, never on id alone (cross-org rows can
  -- legitimately share an id since migration 024).
  WITH deleted AS (
    DELETE FROM public.roster_players rp
    USING _roster_dedupe_plan p
    WHERE rp.org_id = p.org_id
      AND rp.id     = p.id
      AND p.rn      > 1
    RETURNING 1
  )
  SELECT count(*) INTO v_actual_deletes FROM deleted;

  RAISE NOTICE 'Roster dedupe: deleted % duplicate row(s).', v_actual_deletes;

  -- Post-flight: deletion-count sanity gate.
  IF v_actual_deletes <> v_planned_deletes THEN
    RAISE EXCEPTION 'Roster dedupe mismatch: planned=%, actual=%. Aborting.',
      v_planned_deletes, v_actual_deletes;
  END IF;

  -- Post-flight: nothing left over.
  SELECT count(*) INTO v_remaining_clusters
  FROM (
    SELECT 1
    FROM public.roster_players
    WHERE coalesce(first_name,'')    <> ''
      AND coalesce(last_name,'')     <> ''
      AND coalesce(date_of_birth,'') <> ''
    GROUP BY
      org_id,
      lower(trim(first_name)),
      lower(trim(last_name)),
      date_of_birth
    HAVING count(*) > 1
  ) leftover;

  IF v_remaining_clusters > 0 THEN
    RAISE EXCEPTION 'Roster dedupe completed but % cluster(s) still have duplicates. Aborting (will roll back the deletes).',
      v_remaining_clusters;
  END IF;

  RAISE NOTICE 'Roster dedupe complete. Affected orgs: %.', v_affected_orgs;
END
$$;

COMMIT;

-- After applying:
--   1. Re-run the audit query you used earlier:
--        WITH d AS (
--          SELECT org_id,
--                 lower(trim(coalesce(first_name,''))) AS fn,
--                 lower(trim(coalesce(last_name,'')))  AS ln,
--                 coalesce(date_of_birth,'')           AS dob,
--                 count(*)                             AS rows_in_cluster
--          FROM public.roster_players
--          WHERE coalesce(first_name,'') <> ''
--            AND coalesce(last_name,'')  <> ''
--          GROUP BY 1,2,3,4
--          HAVING count(*) > 1
--        )
--        SELECT count(*) FROM d;
--      Expected: 0.
--
--   2. Spot-check a few clusters from the original Q2 list to confirm
--      one row remains and it has the expected (blank) rich-data state.
--
--   3. Reload Expo Go to make sure the in-app roster view is consistent
--      with the cloud (the realtime subscription should propagate the
--      deletes; if not, pull-to-refresh).
