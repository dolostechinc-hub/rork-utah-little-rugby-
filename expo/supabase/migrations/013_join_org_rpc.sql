-- ============================================================================
-- Migration 013: Bulletproof org create / lookup / join via SECURITY DEFINER
-- ============================================================================
-- Problem:
--   Even with migration 012, some projects still have lingering restrictive
--   policies on `organizations` / `org_members`, or the anon policy never got
--   recreated, so testers on other devices get zero rows back when looking up
--   an invite code. The app then shows "Organization not found".
--
-- Fix:
--   Provide SECURITY DEFINER functions that bypass RLS entirely for the two
--   things that MUST work for invite codes to function across devices:
--     1. public_lookup_org_by_code(p_code)  -- tester scans/enters the code
--     2. public_upsert_organization(...)    -- admin pushes org to cloud
--     3. public_join_org(p_code, p_user_id, p_name, p_email)
--        -- tester joins an org; returns the org row
--
--   Because these functions are SECURITY DEFINER and owned by postgres, they
--   run with the table owner's privileges and are NOT blocked by RLS. They
--   are granted to anon + authenticated so the mobile app (which uses the
--   anon key) can call them without any auth session.
--
--   This also re-asserts the permissive policies from 012 so that direct
--   table reads keep working as a fallback.
-- ============================================================================

-- --- Re-assert permissive policies from 012 (idempotent) ---------------------
DO $$
BEGIN
  -- organizations
  EXECUTE 'ALTER TABLE organizations ENABLE ROW LEVEL SECURITY';

  -- Drop any lingering restrictive policies so they don't silently shadow
  -- the permissive ones. Dropping a non-existent policy is a no-op here
  -- because we wrap in IF EXISTS.
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

  -- org_members
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

-- --- RPC: look up an org by code --------------------------------------------
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
  WHERE UPPER(o.code) = UPPER(TRIM(p_code))
  LIMIT 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.public_lookup_org_by_code(TEXT) TO anon, authenticated;

-- --- RPC: upsert an org (admin pushes to cloud) -----------------------------
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
  VALUES (p_id, p_name, UPPER(TRIM(p_code)), p_logo_uri,
          COALESCE(p_primary_color, '#0B7A4B'), p_owner_id, p_expires_at,
          COALESCE(p_created_at, NOW()))
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

-- --- RPC: join an org by code (tester on another device) --------------------
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
  WHERE UPPER(o.code) = UPPER(TRIM(p_code))
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

-- --- RPC: upsert an org member (admin pushes members to cloud) --------------
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
    SET role      = EXCLUDED.role,
        email     = EXCLUDED.email,
        name      = EXCLUDED.name
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.public_upsert_org_member(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ
) TO anon, authenticated;
