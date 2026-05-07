-- 040_organizations_is_active.sql
--
-- Add `is_active` to public.organizations so seasons/leagues that
-- have wrapped up (e.g. the existing Summer 7's org 296fbc1a-…)
-- can be hidden from default UI surfaces without being deleted.
--
-- Contract:
--   - is_active = true   (default) — fully usable in the app.
--   - is_active = false           — hidden from default lookups
--                                   and join-by-code, but rows are
--                                   preserved for historical reference.
--
-- Notes:
--   - Defaults true and is NOT NULL; existing orgs are unaffected.
--   - No RLS changes here — UI-level filtering is sufficient. We
--     do not want SELECT policies to hide inactive orgs from admins
--     because admins still need to view/restore them.
--   - Idempotent: re-running is a no-op.

BEGIN;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.organizations.is_active IS
  'Whether this org is still in active use. False hides it from default '
  'org-list and join-by-code surfaces; admins can still view/edit. '
  'Added in migration 040.';

-- Helpful index for the very common "list active orgs" query.
CREATE INDEX IF NOT EXISTS idx_organizations_is_active
  ON public.organizations (is_active)
  WHERE is_active = true;

-- Sanity log.
DO $$
DECLARE
  v_total int;
  v_active int;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE is_active)
    INTO v_total, v_active
  FROM public.organizations;

  RAISE NOTICE '[040] organizations: total=% active=% (all defaulted to active on backfill)',
    v_total, v_active;
END $$;

COMMIT;
