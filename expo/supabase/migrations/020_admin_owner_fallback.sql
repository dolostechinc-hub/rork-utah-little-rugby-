-- ============================================================================
-- Migration 020: Admin authorization fallback to organizations.owner_id
-- ============================================================================
-- Problem (observed when admin tries to rotate the editor PIN or lock the
-- event to view-only):
--   The RPCs `issue_editor_pin`, `revoke_editor_pin`,
--   `revoke_all_editor_access`, and `set_org_event_mode` authorize the caller
--   by looking up `org_members` for the supplied admin user id. If the
--   owner row never made it into `org_members` (e.g. the org was created
--   while offline and the member upsert was deferred), every admin RPC
--   call returns "Unauthorized" and the UI shows a generic failure.
--
-- Fix:
--   Extend `is_admin_of_org` to also accept the caller as admin when the
--   supplied user id matches the organization's `owner_id`. This is safe
--   because `organizations.owner_id` is set exactly once at create time
--   and never reassignable from the client.
--
-- We also reload the PostgREST schema cache so the new function body is
-- picked up immediately.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.is_admin_of_org(p_org_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM organizations o
      WHERE o.id = p_org_id
        AND o.owner_id = COALESCE(p_user_id, auth.uid())
    )
    OR EXISTS (
      SELECT 1 FROM org_members m
      WHERE m.org_id = p_org_id
        AND m.user_id = COALESCE(p_user_id, auth.uid())
        AND m.role IN ('owner', 'admin')
    );
$$;

GRANT EXECUTE ON FUNCTION public.is_admin_of_org(UUID, UUID) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
