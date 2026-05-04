-- ============================================================================
-- Migration 024: Org-scoped roster keys + client-controlled timestamp
-- ============================================================================
-- Audit findings addressed:
--
-- Critical #1: roster_players is keyed only by `id`, but local clients
--   generate ids from `Date.now()` and `imported-${Date.now()}-${index}`.
--   Two devices/orgs can collide, causing one org's upsert to overwrite or
--   move another org's row. Fix: composite primary key on (org_id, id), with
--   a one-time re-key for any existing cross-org collisions so we don't
--   lose data when changing the constraint. App code is updated separately
--   to use `onConflict: 'org_id,id'` and to generate collision-resistant
--   ids.
--
-- Critical #2: the existing trigger always rewrites updated_at = NOW(),
--   so the app's attempt to set `updated_at: lastEditedAt` on upsert is
--   discarded. That makes the remote row look "newer" than every queued
--   local edit, and the app drops those edits. Fix: add a separate
--   `client_updated_at TIMESTAMPTZ` column that the trigger does NOT touch,
--   so the client can carry its own monotonic edit timestamp through the
--   round-trip. The existing `updated_at` column is preserved as the
--   server-side replication ordering field.
--
-- This migration is idempotent and safe to run more than once.
-- Wrap in a transaction so it can be rolled back if the duplicate report
-- looks suspicious.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Add client_updated_at. Default to updated_at so existing rows are
--    indistinguishable from rows that have never been touched by the new
--    client. The roster trigger from migration 010 stays as-is and does
--    not touch this column.
-- ----------------------------------------------------------------------------
ALTER TABLE public.roster_players
  ADD COLUMN IF NOT EXISTS client_updated_at TIMESTAMPTZ;

UPDATE public.roster_players
SET client_updated_at = COALESCE(client_updated_at, updated_at, NOW())
WHERE client_updated_at IS NULL;

-- Helpful for the queue's per-player `select id, client_updated_at` round-trip.
CREATE INDEX IF NOT EXISTS idx_roster_players_client_updated_at
  ON public.roster_players(org_id, client_updated_at DESC);

-- ----------------------------------------------------------------------------
-- 2. Detect cross-org id collisions. With the current `id PRIMARY KEY`,
--    only one row per `id` can exist, so collisions are theoretical for
--    rows already in the DB. But a previously-deployed earlier schema or
--    an aborted migration could have left orphans. We log them so the
--    operator can see what happened. The CTE result is written to a
--    NOTICE so it shows up in the SQL editor output.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  collision_count INT;
BEGIN
  SELECT COUNT(*) INTO collision_count
  FROM (
    SELECT id
    FROM public.roster_players
    GROUP BY id
    HAVING COUNT(DISTINCT org_id) > 1
  ) collisions;

  IF collision_count > 0 THEN
    RAISE NOTICE 'roster_players: % ids exist in multiple orgs; they will be re-keyed before composite PK is added.', collision_count;
  END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- 3. Re-key any cross-org duplicates so the composite (org_id, id) is
--    unique without losing data. We keep the row in the org with the
--    largest updated_at as the canonical id and rewrite the other rows
--    to `${id}__${short_org_id}` so they survive the constraint change.
--    This is a no-op if no collisions exist.
-- ----------------------------------------------------------------------------
WITH ranked AS (
  SELECT
    id,
    org_id,
    updated_at,
    ROW_NUMBER() OVER (
      PARTITION BY id
      ORDER BY updated_at DESC NULLS LAST, org_id ASC
    ) AS rn
  FROM public.roster_players
)
UPDATE public.roster_players rp
SET id = rp.id || '__' || substr(rp.org_id, 1, 8)
FROM ranked r
WHERE rp.id = r.id
  AND rp.org_id = r.org_id
  AND r.rn > 1;

-- ----------------------------------------------------------------------------
-- 4. Replace the id-only primary key with a composite (org_id, id) PK so
--    the same id can legitimately exist in two different orgs without
--    one upsert clobbering the other. The original `id` column is kept,
--    just no longer unique by itself.
--
--    NOTE on FKs: there are no FKs into roster_players in the current
--    schema (verified via migrations 001-023). If one is added later,
--    the referencing table will need (org_id, id) too.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'roster_players_pkey'
      AND conrelid = 'public.roster_players'::regclass
  ) THEN
    ALTER TABLE public.roster_players DROP CONSTRAINT roster_players_pkey;
  END IF;
END
$$;

ALTER TABLE public.roster_players
  ADD CONSTRAINT roster_players_pkey PRIMARY KEY (org_id, id);

-- A plain index on `id` is no longer required for uniqueness, but a few
-- legacy queries (e.g. realtime payload lookups) may still benefit. Add a
-- non-unique one to keep them fast.
CREATE INDEX IF NOT EXISTS idx_roster_players_id ON public.roster_players(id);

COMMIT;

-- ============================================================================
-- Verification queries you can run after the migration (read-only):
--
--   SELECT id, COUNT(DISTINCT org_id) AS orgs
--   FROM public.roster_players
--   GROUP BY id
--   HAVING COUNT(DISTINCT org_id) > 1;
--   -- expected: zero rows
--
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'public.roster_players'::regclass
--     AND contype = 'p';
--   -- expected: PRIMARY KEY (org_id, id)
--
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema='public'
--     AND table_name='roster_players'
--     AND column_name='client_updated_at';
--   -- expected: client_updated_at
-- ============================================================================
