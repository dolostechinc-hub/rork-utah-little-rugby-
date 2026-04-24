-- ============================================================================
-- Migration 014: Fix organizations schema drift + bulletproof join flow
-- ============================================================================
-- Problem identified from production Supabase project:
--   The `organizations` table is missing the `expires_at` column (7 cols only:
--   id, name, code, logo_uri, primary_color, owner_id, created_at). This makes
--   migration 013's RPCs fail silently because they INSERT/SELECT expires_at,
--   so orgs never actually get saved to Supabase and invite codes only work on
--   the creator's device.
--
-- This migration:
--   1) Adds expires_at to organizations if missing (nullable, safe default).
--   2) Re-creates the public_* RPCs in a way that tolerates either schema.
--   3) Re-asserts permissive RLS policies from 012/013 so anon can read/write.
--   4) Adds a unique constraint on (org_id, user_id) for org_members (required
--      by ON CONFLICT in public_upsert_org_member / public_join_org).
-- ============================================================================

-- --- 1. Add missing columns if needed ---------------------------------------
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Backfill expires_at for existing rows that don't have one (4 months from created_at)
UPDATE organizations
SET expires_at = COALESCE(created_at, NOW()) + INTERVAL '4 months'
WHERE expires_at IS NULL;

-- --- 2. Ensure org_members has the unique constraint ON CONFLICT needs ------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'org_members_org_user_unique'
  ) THEN
    BEGIN
      EXECUTE 'ALTER TABLE org_members
               ADD CONSTRAINT org_members_org_user_unique UNIQUE (org_id, user_id)';
    EXCEPTION WHEN duplicate_table OR duplicate_object OR unique_violation THEN
      -- Ignore; possibly added by earlier migration under different name
      NULL;
    END;
  END IF;
END $$;

-- --- 3. Re-assert permissive RLS policies (idempotent) ----------------------
DO $$
BEGIN
  EXECUTE 'ALTER TABLE organizations ENABLE ROW LEVEL SECURITY';

  EXECUTE 'DROP POLICY IF EXISTS "Users can view orgs they belong to"    ON organizations';
  EXECUTE 'DROP POLICY IF EXISTS "Anyone can look up orgs by code"       ON organizations';
  EXECUTE 'DROP POLICY IF EXISTS "Users can create organizations"        ON organizations';
  EXECUTE 'DROP POLICY IF EXISTS "Admins can update their organizations" ON organizations';
  EXECUTE 'DROP POLICY IF EXISTS "Owners can delete their organizations" ON organizations';
  EXECUTE 'DROP POLICY IF EXISTS "Anon can read organizations"           ON organizations';
  EXECUTE 'DROP POLICY IF EXISTS "Anon can create organizations"         ON organizations';
  EXECUTE 'DROP POLICY IF EXISTS "Anon can update organizations"         ON organizations';
  EXECUTE 'DROP POLICY IF EXISTS "Anon can delete organizations"         ON organizations';

  EXECUTE 'CREATE POLICY "Anon can read organizations"   ON organizations FOR SELECT USING (true)';
  EXECUTE 'CREATE POLICY "Anon can create organizations" ON organizations FOR INSERT WITH CHECK (true)';
  EXECUTE 'CREATE POLICY "Anon can update organizations" ON organizations FOR UPDATE USING (true) WITH CHECK (true)';
  EXECUTE 'CREATE POLICY "Anon can delete organizations" ON organizations FOR DELETE USING (true)';

  EXECUTE 'ALTER TABLE org_members ENABLE ROW LEVEL SECURITY';

  EXECUTE 'DROP POLICY IF EXISTS "Members can view org members of their orgs" ON org_members';
  EXECUTE 'DROP POLICY IF EXISTS "Admins can insert org members"              ON org_members';
  EXECUTE 'DROP POLICY IF EXISTS "Admins can update org members"              ON org_members';
  EXECUTE 'DROP POLICY IF EXISTS "Admins can delete org members"              ON org_members';
  EXECUTE 'DROP POLICY IF EXISTS "Anon can read org_members"                  ON org_members';
  EXECUTE 'DROP POLICY IF EXISTS "Anon can insert org_members"                ON org_members';
  EXECUTE 'DROP POLICY IF EXISTS "Anon can update org_members"                ON org_members';
  EXECUTE 'DROP POLICY IF EXISTS "Anon can delete org_members"                ON org_members';

  EXECUTE 'CREATE POLICY "Anon can read org_members"   ON org_members FOR SELECT USING (true)';
  EXECUTE 'CREATE POLICY "Anon can insert org_members" ON org_members FOR INSERT WITH CHECK (true)';
  EXECUTE 'CREATE POLICY "Anon can update org_members" ON org_members FOR UPDATE USING (true) WITH CHECK (true)';
  EXECUTE 'CREATE POLICY "Anon can delete org_members" ON org_members FOR DELETE USING (true)';
END $$;

-- --- 4. Drop old RPC signatures so we can recreate cleanly ------------------
DROP FUNCTION IF EXISTS public.public_lookup_org_by_code(TEXT);
DROP FUNCTION IF EXISTS public.public_upsert_organization(UUID, TEXT, TEXT, TEXT, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.public_join_org(TEXT, UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.public_upsert_org_member(UUID, UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ);

-- --- 5. RPC: look up an org by code -----------------------------------------
CREATE OR REPLACE FUNCTION public.public_lookup_org_by_code(p_code TEXT)
RETURNS TABLE (
  id             UUID,
  name           TEXT,
  code           TEXT,
  logo_uri       TEXT,
  primary_color  TEXT,
  owner_id       UUID,
  created_at     TIMESTAMPTZ,
  expires_at     TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT o.id, o.name, o.code, o.logo_uri, o.primary_color,
         o.owner_id, o.created_at, o.expires_at
  FROM organizations o
  WHERE UPPER(TRIM(o.code)) = UPPER(TRIM(p_code))
  LIMIT 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.public_lookup_org_by_code(TEXT) TO anon, authenticated;

-- --- 6. RPC: upsert an org (admin pushes to cloud) --------------------------
CREATE OR REPLACE FUNCTION public.public_upsert_organization(
  p_id            UUID,
  p_name          TEXT,
  p_code          TEXT,
  p_logo_uri      TEXT,
  p_primary_color TEXT,
  p_owner_id      UUID,
  p_expires_at    TIMESTAMPTZ,
  p_created_at    TIMESTAMPTZ
)
RETURNS organizations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row organizations;
BEGIN
  INSERT INTO organizations (id, name, code, logo_uri, primary_color, owner_id, expires_at, created_at)
  VALUES (
    p_id,
    p_name,
    UPPER(TRIM(p_code)),
    p_logo_uri,
    COALESCE(p_primary_color, '#0B7A4B'),
    p_owner_id,
    COALESCE(p_expires_at, NOW() + INTERVAL '4 months'),
    COALESCE(p_created_at, NOW())
  )
  ON CONFLICT (id) DO UPDATE
    SET name          = EXCLUDED.name,
        code          = EXCLUDED.code,
        logo_uri      = EXCLUDED.logo_uri,
        primary_color = EXCLUDED.primary_color,
        owner_id      = EXCLUDED.owner_id,
        expires_at    = EXCLUDED.expires_at
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.public_upsert_organization(
  UUID, TEXT, TEXT, TEXT, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ
) TO anon, authenticated;

-- --- 7. RPC: join an org by code --------------------------------------------
CREATE OR REPLACE FUNCTION public.public_join_org(
  p_code    TEXT,
  p_user_id UUID,
  p_name    TEXT,
  p_email   TEXT
)
RETURNS TABLE (
  id            UUID,
  name          TEXT,
  code          TEXT,
  logo_uri      TEXT,
  primary_color TEXT,
  owner_id      UUID,
  created_at    TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org organizations;
BEGIN
  SELECT * INTO v_org
  FROM organizations o
  WHERE UPPER(TRIM(o.code)) = UPPER(TRIM(p_code))
  LIMIT 1;

  IF v_org.id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO org_members (org_id, user_id, role, email, name)
  VALUES (v_org.id, p_user_id, 'volunteer', COALESCE(p_email, ''), COALESCE(p_name, 'Volunteer'))
  ON CONFLICT (org_id, user_id) DO NOTHING;

  RETURN QUERY
  SELECT v_org.id, v_org.name, v_org.code, v_org.logo_uri,
         v_org.primary_color, v_org.owner_id, v_org.created_at, v_org.expires_at;
END;
$$;

GRANT EXECUTE ON FUNCTION public.public_join_org(TEXT, UUID, TEXT, TEXT) TO anon, authenticated;

-- --- 8. RPC: upsert an org member -------------------------------------------
CREATE OR REPLACE FUNCTION public.public_upsert_org_member(
  p_id        UUID,
  p_org_id    UUID,
  p_user_id   UUID,
  p_role      TEXT,
  p_email     TEXT,
  p_name      TEXT,
  p_joined_at TIMESTAMPTZ
)
RETURNS org_members
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row org_members;
BEGIN
  INSERT INTO org_members (id, org_id, user_id, role, email, name, joined_at)
  VALUES (p_id, p_org_id, p_user_id, p_role, COALESCE(p_email, ''),
          COALESCE(p_name, ''), COALESCE(p_joined_at, NOW()))
  ON CONFLICT (org_id, user_id) DO UPDATE
    SET role  = EXCLUDED.role,
        email = EXCLUDED.email,
        name  = EXCLUDED.name
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.public_upsert_org_member(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ
) TO anon, authenticated;

-- --- 9. Backfill: push any local-only orgs ... (handled by the app) ---------
-- Nothing to do server-side here; the app's auto-sync in OrganizationContext
-- will upload local orgs now that the schema/RPCs work.
