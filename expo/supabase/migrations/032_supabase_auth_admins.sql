-- ============================================================================
-- Migration 032: Supabase-auth-backed admin identity (league + per-org)
-- ============================================================================
-- Replaces the device-bound admin model with a user-bound one. After this
-- migration, admin-ness is determined by auth.uid() instead of by which
-- device created the org. The old synthetic-UUID checks (organizations.owner_id
-- and org_members.user_id) are kept untouched for backwards compat -- they
-- continue to work for existing orgs whose admins haven't signed in yet.
--
-- Two tiers of admin:
--   1. League admin (`app_admins`)  -- admin of every org, automatically.
--   2. Org admin    (`org_members.auth_uid` with role IN ('owner','admin'))
--
-- Bootstrap (one-time, manual, see PLAN_admin_auth.md):
--   1. The first league admin signs in via the app. This creates their
--      auth.users row.
--   2. Run, in the SQL editor:
--        INSERT INTO public.app_admins (auth_uid, email)
--        VALUES ((SELECT id FROM auth.users WHERE email = 'you@example.com'),
--                'you@example.com');
--   3. From here on, league admins are managed entirely through the app
--      via grant_app_admin / revoke_app_admin.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. app_admins table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_admins (
  auth_uid  UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email     TEXT NOT NULL,
  added_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  added_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.app_admins ENABLE ROW LEVEL SECURITY;

-- Read policy: only existing app admins can see the list. We use a
-- subquery instead of recursing into the table the policy is on; PG
-- handles this fine because the subquery is evaluated as the caller.
DROP POLICY IF EXISTS app_admins_read ON public.app_admins;
CREATE POLICY app_admins_read ON public.app_admins
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.app_admins a WHERE a.auth_uid = auth.uid()
    )
  );

-- No INSERT/UPDATE/DELETE policies on purpose. All writes go through the
-- SECURITY DEFINER RPCs below, which can re-check is_app_admin() server
-- side. The first row is inserted manually with a service-role statement
-- (which bypasses RLS) at bootstrap time.

-- ----------------------------------------------------------------------------
-- 2. org_members.auth_uid for per-org admins tied to a real user
-- ----------------------------------------------------------------------------
ALTER TABLE public.org_members
  ADD COLUMN IF NOT EXISTS auth_uid UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- A given auth user can be a member of an org at most once. We keep the
-- existing synthetic-UUID rows untouched; the partial unique index only
-- applies to rows that have an auth_uid set.
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_members_org_auth_uid
  ON public.org_members(org_id, auth_uid)
  WHERE auth_uid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_org_members_auth_uid
  ON public.org_members(auth_uid)
  WHERE auth_uid IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 3. is_app_admin() helper -- used by the new RPCs and by is_admin_of_org
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_app_admin(p_uid UUID DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.app_admins
    WHERE auth_uid = COALESCE(p_uid, auth.uid())
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_app_admin(UUID) TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4. is_admin_of_org() learns the auth-backed clauses
-- ----------------------------------------------------------------------------
-- Existing clauses kept unchanged for backwards compat with the synthetic
-- UUID system. New clauses added on top:
--   * Caller is in app_admins (league admin).
--   * Caller has an org_members row in this org with auth_uid = caller and
--     role in ('owner','admin').
-- The "caller" is auth.uid() if the user is signed in; otherwise we fall
-- back to the explicitly-supplied p_user_id to preserve compatibility with
-- pre-auth client code that passes its synthetic UUID.
CREATE OR REPLACE FUNCTION public.is_admin_of_org(p_org_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    -- League admin via auth.uid() -- highest precedence.
    EXISTS (
      SELECT 1 FROM public.app_admins
      WHERE auth_uid = COALESCE(auth.uid(), p_user_id)
    )
    -- Org admin via auth.uid() linked org_members row.
    OR EXISTS (
      SELECT 1 FROM public.org_members m
      WHERE m.org_id = p_org_id
        AND m.auth_uid = COALESCE(auth.uid(), p_user_id)
        AND m.role IN ('owner', 'admin')
    )
    -- Legacy: caller is the org's synthetic owner_id (migration 020 fallback).
    OR EXISTS (
      SELECT 1 FROM public.organizations o
      WHERE o.id = p_org_id
        AND o.owner_id = COALESCE(p_user_id, auth.uid())
    )
    -- Legacy: caller is in org_members with synthetic user_id.
    OR EXISTS (
      SELECT 1 FROM public.org_members m
      WHERE m.org_id = p_org_id
        AND m.user_id = COALESCE(p_user_id, auth.uid())
        AND m.role IN ('owner', 'admin')
    );
$$;

GRANT EXECUTE ON FUNCTION public.is_admin_of_org(UUID, UUID) TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- 5. League admin management RPCs
-- ----------------------------------------------------------------------------

-- list_app_admins() -- returns the league admin roster. Authorised via
-- is_app_admin() on the caller; non-admins get a clean empty array.
CREATE OR REPLACE FUNCTION public.list_app_admins()
RETURNS TABLE (
  auth_uid  UUID,
  email     TEXT,
  added_by  UUID,
  added_at  TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_app_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN QUERY
    SELECT a.auth_uid, a.email, a.added_by, a.added_at
    FROM public.app_admins a
    ORDER BY a.added_at ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_app_admins() TO anon, authenticated;

-- grant_app_admin(p_email) -- promote a signed-in user to league admin.
-- The target user must have signed in at least once so an auth.users row
-- exists. The caller must already be a league admin.
CREATE OR REPLACE FUNCTION public.grant_app_admin(p_email TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_target_uid UUID;
  v_norm_email TEXT;
BEGIN
  IF NOT public.is_app_admin(auth.uid()) THEN
    RETURN json_build_object('error', 'Unauthorized');
  END IF;

  v_norm_email := lower(trim(coalesce(p_email, '')));
  IF v_norm_email = '' THEN
    RETURN json_build_object('error', 'Email is required');
  END IF;

  SELECT id INTO v_target_uid
    FROM auth.users
   WHERE lower(email) = v_norm_email
   LIMIT 1;

  IF v_target_uid IS NULL THEN
    RETURN json_build_object(
      'error',
      'No user has signed in with that email yet. Ask them to open the app and sign in once, then try again.'
    );
  END IF;

  INSERT INTO public.app_admins (auth_uid, email, added_by)
  VALUES (v_target_uid, v_norm_email, auth.uid())
  ON CONFLICT (auth_uid) DO UPDATE
    SET email = EXCLUDED.email;

  RETURN json_build_object('ok', true, 'auth_uid', v_target_uid);
END;
$$;

GRANT EXECUTE ON FUNCTION public.grant_app_admin(TEXT) TO authenticated;

-- revoke_app_admin(p_target_uid) -- remove someone from the league admin
-- list. Refuses if it would empty the table (defends against the obvious
-- self-foot-shooting case). Refuses if the caller is the target *and* is
-- the only league admin.
CREATE OR REPLACE FUNCTION public.revoke_app_admin(p_target_uid UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_remaining INTEGER;
  v_existed   INTEGER;
BEGIN
  IF NOT public.is_app_admin(auth.uid()) THEN
    RETURN json_build_object('error', 'Unauthorized');
  END IF;

  IF p_target_uid IS NULL THEN
    RETURN json_build_object('error', 'Target auth_uid is required');
  END IF;

  SELECT count(*) INTO v_existed FROM public.app_admins WHERE auth_uid = p_target_uid;
  IF v_existed = 0 THEN
    RETURN json_build_object('ok', true, 'changed', false);
  END IF;

  SELECT count(*) INTO v_remaining FROM public.app_admins WHERE auth_uid <> p_target_uid;
  IF v_remaining = 0 THEN
    RETURN json_build_object(
      'error',
      'Refusing to remove the last league admin. Add another league admin first, then revoke this one.'
    );
  END IF;

  DELETE FROM public.app_admins WHERE auth_uid = p_target_uid;

  RETURN json_build_object('ok', true, 'changed', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.revoke_app_admin(UUID) TO authenticated;

-- ----------------------------------------------------------------------------
-- 6. Per-org admin grants by email
-- ----------------------------------------------------------------------------

-- grant_org_admin_by_email(p_org_id, p_email) -- promote a signed-in user
-- to org admin via their email address. Caller must be admin of that org
-- (league or org admin). Companion to migration 030's grant_org_admin
-- which takes a synthetic UUID; this is the auth-aware version.
CREATE OR REPLACE FUNCTION public.grant_org_admin_by_email(
  p_org_id  UUID,
  p_email   TEXT,
  -- Backwards-compat fallback: pre-auth clients that don't have
  -- auth.uid() can still authorise via their synthetic admin UUID.
  p_admin_user_id UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_target_uid    UUID;
  v_norm_email    TEXT;
  v_existing_role TEXT;
BEGIN
  IF NOT public.is_admin_of_org(p_org_id, p_admin_user_id) THEN
    RETURN json_build_object('error', 'Unauthorized');
  END IF;

  v_norm_email := lower(trim(coalesce(p_email, '')));
  IF v_norm_email = '' THEN
    RETURN json_build_object('error', 'Email is required');
  END IF;

  SELECT id INTO v_target_uid
    FROM auth.users
   WHERE lower(email) = v_norm_email
   LIMIT 1;

  IF v_target_uid IS NULL THEN
    RETURN json_build_object(
      'error',
      'No user has signed in with that email yet. Ask them to open the app and sign in once, then try again.'
    );
  END IF;

  -- Upsert. If a row already exists for this auth_uid in this org we
  -- promote it to admin (without clobbering owner role).
  SELECT role INTO v_existing_role
    FROM public.org_members
   WHERE org_id = p_org_id
     AND auth_uid = v_target_uid;

  IF v_existing_role IS NULL THEN
    -- No row yet for this auth user; create one. user_id is set to a
    -- fresh UUID so the (org_id, user_id) composite is unique among
    -- legacy rows; future code reads auth_uid as the canonical id.
    INSERT INTO public.org_members (org_id, user_id, auth_uid, role, email)
    VALUES (p_org_id, gen_random_uuid(), v_target_uid, 'admin', v_norm_email);
  ELSIF v_existing_role <> 'owner' THEN
    UPDATE public.org_members
       SET role  = 'admin',
           email = COALESCE(NULLIF(email, ''), v_norm_email)
     WHERE org_id = p_org_id AND auth_uid = v_target_uid;
  END IF;

  RETURN json_build_object('ok', true, 'auth_uid', v_target_uid, 'previous_role', COALESCE(v_existing_role, 'none'));
END;
$$;

GRANT EXECUTE ON FUNCTION public.grant_org_admin_by_email(UUID, TEXT, UUID) TO anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- Verification queries (read-only) you can run after applying:
--
--   -- 1. Schema is in place
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='org_members' AND column_name='auth_uid';
--
--   SELECT to_regclass('public.app_admins'); -- expected: public.app_admins
--
--   -- 2. RPCs exist
--   SELECT proname FROM pg_proc
--   WHERE proname IN ('is_app_admin','list_app_admins','grant_app_admin',
--                     'revoke_app_admin','grant_org_admin_by_email');
--
--   -- 3. is_admin_of_org still works for legacy synthetic-UUID admins
--   SELECT public.is_admin_of_org(
--     '<existing org id>',
--     '<existing organizations.owner_id synthetic uuid>'
--   ); -- expected: true
-- ============================================================================
