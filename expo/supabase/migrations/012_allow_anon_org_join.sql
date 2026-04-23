-- ============================================================================
-- Migration 012: Allow anonymous clients to create / join organizations
-- ============================================================================
-- The mobile app does NOT use Supabase Auth. It uses the anon key for all
-- requests. The previous RLS policies required auth.uid() to match owner_id,
-- which blocked every INSERT from the app, meaning organizations never
-- actually reached the cloud and invite codes could not be used from another
-- device (they only lived in the admin's local AsyncStorage).
--
-- This migration relaxes the RLS policies on `organizations` and `org_members`
-- so the anon role can create and join orgs. Photos + players + editor
-- sessions remain protected by the existing editor-session policies.
-- ============================================================================

-- Drop the old policies that assumed Supabase auth
DROP POLICY IF EXISTS "Users can view orgs they belong to"   ON organizations;
DROP POLICY IF EXISTS "Anyone can look up orgs by code"      ON organizations;
DROP POLICY IF EXISTS "Users can create organizations"       ON organizations;
DROP POLICY IF EXISTS "Admins can update their organizations" ON organizations;
DROP POLICY IF EXISTS "Owners can delete their organizations" ON organizations;

-- Anyone (anon app user) can read orgs (needed for the join-by-code lookup)
CREATE POLICY "Anon can read organizations"
  ON organizations FOR SELECT
  USING (true);

-- Anyone can create an organization from the app
CREATE POLICY "Anon can create organizations"
  ON organizations FOR INSERT
  WITH CHECK (true);

-- Anyone can update an organization (app enforces admin-PIN gating client side)
CREATE POLICY "Anon can update organizations"
  ON organizations FOR UPDATE
  USING (true)
  WITH CHECK (true);

-- Anyone can delete an organization (app enforces admin-PIN gating client side)
CREATE POLICY "Anon can delete organizations"
  ON organizations FOR DELETE
  USING (true);

-- ---------------------------------------------------------------------------
-- org_members: needed so a new volunteer can attach themselves to an org
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Members can view org members of their orgs" ON org_members;
DROP POLICY IF EXISTS "Admins can insert org members"              ON org_members;
DROP POLICY IF EXISTS "Admins can update org members"              ON org_members;
DROP POLICY IF EXISTS "Admins can delete org members"              ON org_members;

CREATE POLICY "Anon can read org_members"
  ON org_members FOR SELECT
  USING (true);

CREATE POLICY "Anon can insert org_members"
  ON org_members FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Anon can update org_members"
  ON org_members FOR UPDATE
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Anon can delete org_members"
  ON org_members FOR DELETE
  USING (true);
