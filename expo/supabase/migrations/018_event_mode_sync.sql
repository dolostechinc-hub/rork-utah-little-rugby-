-- ============================================================================
-- Migration 018: Sync event mode (registration vs view-only) across devices
-- ============================================================================
-- Problem:
--   `event_mode` was only persisted to AsyncStorage on the admin device, so
--   locking the event to view-only never propagated to other devices that
--   were already logged in. This migration moves the source of truth to the
--   organization row in Supabase and exposes an RPC the admin can call to
--   atomically flip the lock.
-- ============================================================================

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS event_mode TEXT NOT NULL DEFAULT 'registration';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'organizations_event_mode_check'
  ) THEN
    BEGIN
      EXECUTE 'ALTER TABLE organizations
               ADD CONSTRAINT organizations_event_mode_check
               CHECK (event_mode IN (''registration'', ''viewOnly''))';
    EXCEPTION WHEN duplicate_object THEN
      NULL;
    END;
  END IF;
END $$;

-- Make sure realtime broadcasts include the new column so editors see the
-- lock immediately. organizations is already in the realtime publication
-- (used by org join/refresh), this is a no-op if already added.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename  = 'organizations'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.organizations';
  END IF;
END $$;

-- RPC: set the event mode. Validates the requester is the org owner or admin.
DROP FUNCTION IF EXISTS public.set_org_event_mode(UUID, TEXT, UUID);

CREATE OR REPLACE FUNCTION public.set_org_event_mode(
  p_org_id        UUID,
  p_mode          TEXT,
  p_admin_user_id UUID
)
RETURNS TABLE (
  id         UUID,
  event_mode TEXT,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner UUID;
BEGIN
  IF p_mode NOT IN ('registration', 'viewOnly') THEN
    RAISE EXCEPTION 'invalid event_mode: %', p_mode;
  END IF;

  SELECT o.owner_id INTO v_owner FROM organizations o WHERE o.id = p_org_id;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'organization not found';
  END IF;

  IF v_owner IS DISTINCT FROM p_admin_user_id THEN
    -- Allow if the user is also recorded as an admin/owner member.
    IF NOT EXISTS (
      SELECT 1 FROM org_members m
      WHERE m.org_id = p_org_id
        AND m.user_id = p_admin_user_id
        AND m.role IN ('owner', 'admin')
    ) THEN
      RAISE EXCEPTION 'not authorized to change event mode';
    END IF;
  END IF;

  UPDATE organizations o
     SET event_mode = p_mode
   WHERE o.id = p_org_id;

  RETURN QUERY
  SELECT o.id, o.event_mode, COALESCE(o.updated_at, NOW())
    FROM organizations o
   WHERE o.id = p_org_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_org_event_mode(UUID, TEXT, UUID) TO anon, authenticated;

-- RPC: read event mode (handy for the auto-sync hook when realtime is off).
DROP FUNCTION IF EXISTS public.get_org_event_mode(UUID);

CREATE OR REPLACE FUNCTION public.get_org_event_mode(p_org_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT event_mode FROM organizations WHERE id = p_org_id LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_org_event_mode(UUID) TO anon, authenticated;
