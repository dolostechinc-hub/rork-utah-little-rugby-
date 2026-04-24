-- ============================================================================
-- Migration 015: Fix UPSERT failure due to missing `updated_at` column
-- ============================================================================
-- Problem:
--   A trigger on `organizations` (and likely `org_members`) references
--   NEW.updated_at, but the column was never added. This causes every
--   ON CONFLICT ... DO UPDATE (i.e. every re-upsert) to fail with:
--     42703: record "new" has no field "updated_at"
--
--   Net effect: admin can INSERT an org the first time, but the app's
--   auto-sync re-runs the same upsert, which fails. For some code paths
--   the first insert itself also triggers the update branch (when the
--   row already exists locally), so nothing ever makes it to the cloud.
--
-- Fix:
--   Add `updated_at TIMESTAMPTZ` to `organizations` and `org_members`
--   (nullable, safe default = NOW()) so any trigger that writes to it
--   succeeds. Also (re)create a simple touch-updated-at trigger function
--   in case one is expected but broken.
-- ============================================================================

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE org_members
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Also backfill any nulls just in case the column existed without default.
UPDATE organizations SET updated_at = COALESCE(updated_at, NOW());
UPDATE org_members   SET updated_at = COALESCE(updated_at, NOW());

-- Create (or replace) a standard touch-updated-at trigger function.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- Attach trigger to organizations (idempotent).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'organizations_set_updated_at'
      AND tgrelid = 'public.organizations'::regclass
  ) THEN
    EXECUTE '
      CREATE TRIGGER organizations_set_updated_at
      BEFORE UPDATE ON organizations
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()
    ';
  END IF;
END $$;

-- Attach trigger to org_members (idempotent).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'org_members_set_updated_at'
      AND tgrelid = 'public.org_members'::regclass
  ) THEN
    EXECUTE '
      CREATE TRIGGER org_members_set_updated_at
      BEFORE UPDATE ON org_members
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()
    ';
  END IF;
END $$;
