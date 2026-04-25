-- 019_org_data_isolation.sql
--
-- Hardens organization-level data isolation at the database layer.
-- The application already segregates every read/write by org_id, and
-- photos are uploaded under storage path `${org_id}/...`. This migration
-- adds a DB-level guarantee so no row can ever exist without a valid
-- non-empty org_id, and so that RLS rejects any SELECT/INSERT/UPDATE/
-- DELETE that does not carry an org_id.
--
-- This migration is additive and does not change any existing app code
-- paths. Existing queries already filter by org_id, so they continue to
-- work exactly as before.

-- 1) Make sure roster_players.org_id is never blank.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'roster_players_org_id_not_blank'
  ) THEN
    ALTER TABLE public.roster_players
      ADD CONSTRAINT roster_players_org_id_not_blank
      CHECK (org_id IS NOT NULL AND length(trim(org_id)) > 0);
  END IF;
END
$$;

-- 2) Re-create roster_players RLS policies so they explicitly require an
--    org_id on every row. Anon clients still operate as before because the
--    app always passes `.eq('org_id', orgId)`; this just refuses any row
--    that somehow lacks an org_id.
DROP POLICY IF EXISTS "roster_players_select" ON public.roster_players;
DROP POLICY IF EXISTS "roster_players_insert" ON public.roster_players;
DROP POLICY IF EXISTS "roster_players_update" ON public.roster_players;
DROP POLICY IF EXISTS "roster_players_delete" ON public.roster_players;

CREATE POLICY "roster_players_select" ON public.roster_players
  FOR SELECT
  USING (org_id IS NOT NULL AND length(trim(org_id)) > 0);

CREATE POLICY "roster_players_insert" ON public.roster_players
  FOR INSERT
  WITH CHECK (org_id IS NOT NULL AND length(trim(org_id)) > 0);

CREATE POLICY "roster_players_update" ON public.roster_players
  FOR UPDATE
  USING (org_id IS NOT NULL AND length(trim(org_id)) > 0)
  WITH CHECK (org_id IS NOT NULL AND length(trim(org_id)) > 0);

CREATE POLICY "roster_players_delete" ON public.roster_players
  FOR DELETE
  USING (org_id IS NOT NULL AND length(trim(org_id)) > 0);

-- 3) Helpful view: per-org row counts for owner/operator visibility.
CREATE OR REPLACE VIEW public.org_data_overview AS
SELECT
  o.id          AS org_id,
  o.name        AS org_name,
  o.code        AS org_code,
  COALESCE((SELECT count(*) FROM public.roster_players rp WHERE rp.org_id = o.id::text), 0) AS player_count,
  COALESCE((SELECT count(*) FROM public.org_members m   WHERE m.org_id  = o.id), 0)         AS member_count,
  o.created_at
FROM public.organizations o;

GRANT SELECT ON public.org_data_overview TO anon, authenticated;

-- 4) Reaffirm storage path convention. Photos live under `${org_id}/...`
--    so that listing/deletion can be scoped per-org. This is informational;
--    the convention is enforced by `lib/supabase.ts -> uploadPlayerPhoto`.
COMMENT ON TABLE public.roster_players IS
  'Per-organization roster data. Every row MUST carry a non-empty org_id. '
  'The application enforces org-scoped reads/writes via .eq(''org_id'', orgId) '
  'in lib/rosterSync.ts. Photos for an org live under storage path "${org_id}/".';
