-- ============================================================================
-- Migration 030: Permanent admin role grants via org_members
-- ============================================================================
-- Adds two helper RPCs so an existing admin can promote / demote other users
-- to the persistent `admin` role inside `org_members` without dropping into
-- the SQL editor:
--
--   * grant_org_admin(p_org_id, p_target_user_id, p_admin_user_id, ...)
--       -> Upserts an org_members row with role='admin'.
--   * revoke_org_admin(p_org_id, p_target_user_id, p_admin_user_id)
--       -> Demotes an admin row back to role='volunteer'. Refuses to demote
--          the org's owner (organizations.owner_id) since that is the
--          ultimate fallback used by `is_admin_of_org` (see migration 020).
--
-- Authorization mirrors every other admin RPC in the project: callers must
-- pass `is_admin_of_org` for the same org. The owner_id fallback in
-- migration 020 means the org creator can always grant the first additional
-- admin even if their `org_members` row is missing.
--
-- Idempotency:
--   grant_org_admin upserts on (org_id, user_id). If the row already exists
--   it is rewritten to role='admin' and the supplied email/name fields are
--   only filled in where the existing row has NULL/empty values, so we never
--   clobber a richer existing record.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.grant_org_admin(
  p_org_id          UUID,
  p_target_user_id  UUID,
  p_admin_user_id   UUID DEFAULT NULL,
  p_email           TEXT DEFAULT NULL,
  p_name            TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing_role TEXT;
  v_member_id     UUID;
BEGIN
  IF NOT public.is_admin_of_org(p_org_id, p_admin_user_id) THEN
    RETURN json_build_object('error', 'Unauthorized');
  END IF;

  IF p_target_user_id IS NULL THEN
    RETURN json_build_object('error', 'Target user id is required');
  END IF;

  SELECT id, role INTO v_member_id, v_existing_role
    FROM public.org_members
   WHERE org_id = p_org_id
     AND user_id = p_target_user_id;

  IF v_member_id IS NULL THEN
    INSERT INTO public.org_members (org_id, user_id, role, email, name)
    VALUES (p_org_id, p_target_user_id, 'admin', p_email, p_name)
    RETURNING id INTO v_member_id;
  ELSE
    UPDATE public.org_members
       SET role  = CASE WHEN v_existing_role = 'owner' THEN 'owner' ELSE 'admin' END,
           email = COALESCE(NULLIF(email, ''), p_email),
           name  = COALESCE(NULLIF(name,  ''), p_name)
     WHERE id = v_member_id;
  END IF;

  RETURN json_build_object(
    'ok',         true,
    'member_id',  v_member_id,
    'previous_role', COALESCE(v_existing_role, 'none')
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.grant_org_admin(UUID, UUID, UUID, TEXT, TEXT)
  TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.revoke_org_admin(
  p_org_id          UUID,
  p_target_user_id  UUID,
  p_admin_user_id   UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_owner_id UUID;
  v_existing TEXT;
BEGIN
  IF NOT public.is_admin_of_org(p_org_id, p_admin_user_id) THEN
    RETURN json_build_object('error', 'Unauthorized');
  END IF;

  SELECT owner_id INTO v_owner_id FROM public.organizations WHERE id = p_org_id;
  IF v_owner_id IS NULL THEN
    RETURN json_build_object('error', 'Organization not found');
  END IF;

  -- Refuse to demote the org owner. Demoting them would lock the org
  -- out of every admin RPC (the owner_id fallback in migration 020 is
  -- the last line of defence).
  IF p_target_user_id = v_owner_id THEN
    RETURN json_build_object('error', 'Cannot demote the org owner');
  END IF;

  SELECT role INTO v_existing
    FROM public.org_members
   WHERE org_id = p_org_id AND user_id = p_target_user_id;

  IF v_existing IS NULL THEN
    RETURN json_build_object('error', 'User is not a member of this org');
  END IF;

  IF v_existing NOT IN ('admin', 'owner') THEN
    RETURN json_build_object('ok', true, 'changed', false, 'role', v_existing);
  END IF;

  UPDATE public.org_members
     SET role = 'volunteer'
   WHERE org_id = p_org_id
     AND user_id = p_target_user_id
     AND role = 'admin';

  RETURN json_build_object('ok', true, 'changed', true, 'previous_role', v_existing);
END;
$$;

GRANT EXECUTE ON FUNCTION public.revoke_org_admin(UUID, UUID, UUID)
  TO anon, authenticated;

-- Convenience read for the Settings UI: list every admin/owner of the org
-- so the admin can see who already has permanent access. Mirrors
-- list_editor_sessions in shape and authorization.
CREATE OR REPLACE FUNCTION public.list_org_admins(
  p_org_id        UUID,
  p_admin_user_id UUID DEFAULT NULL
)
RETURNS TABLE (
  member_id  UUID,
  user_id    UUID,
  role       TEXT,
  email      TEXT,
  name       TEXT,
  joined_at  TIMESTAMPTZ,
  is_owner   BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_owner_id UUID;
BEGIN
  IF NOT public.is_admin_of_org(p_org_id, p_admin_user_id) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT owner_id INTO v_owner_id FROM public.organizations WHERE id = p_org_id;

  RETURN QUERY
    SELECT
      m.id          AS member_id,
      m.user_id,
      m.role,
      m.email,
      m.name,
      m.joined_at,
      (m.user_id = v_owner_id) AS is_owner
    FROM public.org_members m
   WHERE m.org_id = p_org_id
     AND m.role IN ('owner', 'admin')
   ORDER BY (m.user_id = v_owner_id) DESC, m.joined_at ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_org_admins(UUID, UUID) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
