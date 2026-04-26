-- ============================================================================
-- Migration 023: Admin visibility & control over individual editor sessions
-- ============================================================================
-- Lets the admin see WHO currently holds an editor session (by the name the
-- volunteer typed when they unlocked access) and revoke a single session
-- without nuking everyone else.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.list_editor_sessions(
  p_org_id        UUID,
  p_admin_user_id UUID DEFAULT NULL
)
RETURNS TABLE (
  id            UUID,
  device_label  TEXT,
  pin_label     TEXT,
  issued_at     TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_admin_of_org(p_org_id, p_admin_user_id) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN QUERY
    SELECT
      s.id,
      s.device_label,
      p.label AS pin_label,
      s.issued_at,
      s.expires_at,
      s.last_used_at,
      s.revoked_at
    FROM editor_sessions s
    LEFT JOIN editor_pins p ON p.id = s.pin_id
    WHERE s.org_id = p_org_id
      AND s.revoked_at IS NULL
      AND s.expires_at > now()
    ORDER BY s.issued_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_editor_sessions(UUID, UUID) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.revoke_editor_session(
  p_session_id    UUID,
  p_admin_user_id UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org UUID;
BEGIN
  SELECT org_id INTO v_org FROM editor_sessions WHERE id = p_session_id;
  IF v_org IS NULL THEN
    RETURN json_build_object('error', 'Session not found');
  END IF;
  IF NOT public.is_admin_of_org(v_org, p_admin_user_id) THEN
    RETURN json_build_object('error', 'Unauthorized');
  END IF;

  UPDATE editor_sessions
  SET revoked_at = now()
  WHERE id = p_session_id AND revoked_at IS NULL;

  RETURN json_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.revoke_editor_session(UUID, UUID) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
