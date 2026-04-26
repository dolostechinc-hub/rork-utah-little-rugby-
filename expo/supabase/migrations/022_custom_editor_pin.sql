-- ============================================================================
-- Migration 022: Allow admins to optionally specify a custom Editor PIN
-- ============================================================================
--
-- Adds an optional `p_custom_pin` argument to issue_editor_pin.
-- - If NULL or empty -> behaves exactly like before (auto-generates a 6-digit PIN).
-- - If provided      -> uses that PIN as long as it is 4-10 digits.
--
-- Backwards compatible: existing app builds call this RPC with the old 4 named
-- arguments; the new 5th argument simply defaults to NULL so they keep working
-- without an app update. Once a new build ships, the app can pass a custom PIN.
-- ============================================================================

DROP FUNCTION IF EXISTS public.issue_editor_pin(UUID, INTEGER, TEXT, UUID);
DROP FUNCTION IF EXISTS public.issue_editor_pin(UUID, INTEGER, TEXT, UUID, TEXT);

CREATE OR REPLACE FUNCTION public.issue_editor_pin(
  p_org_id              UUID,
  p_expires_in_minutes  INTEGER DEFAULT 480,
  p_label               TEXT    DEFAULT NULL,
  p_admin_user_id       UUID    DEFAULT NULL,
  p_custom_pin          TEXT    DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_pin     TEXT;
  v_pin_id  UUID;
  v_expires TIMESTAMPTZ;
  v_clean   TEXT;
BEGIN
  IF NOT public.is_admin_of_org(p_org_id, p_admin_user_id) THEN
    RETURN json_build_object('error', 'Unauthorized');
  END IF;

  IF p_expires_in_minutes IS NULL OR p_expires_in_minutes < 5 THEN
    p_expires_in_minutes := 480;
  END IF;

  IF p_custom_pin IS NOT NULL AND length(trim(p_custom_pin)) > 0 THEN
    v_clean := trim(p_custom_pin);
    IF v_clean !~ '^[0-9]{4,10}$' THEN
      RETURN json_build_object('error', 'Custom PIN must be 4-10 digits.');
    END IF;
    v_pin := v_clean;
  ELSE
    v_pin := lpad((floor(random() * 1000000))::int::text, 6, '0');
  END IF;

  v_expires := now() + (p_expires_in_minutes || ' minutes')::interval;

  INSERT INTO editor_pins (org_id, pin_hash, label, created_by, expires_at)
  VALUES (
    p_org_id,
    encode(extensions.digest(v_pin || p_org_id::text, 'sha256'), 'hex'),
    p_label,
    COALESCE(auth.uid(), p_admin_user_id),
    v_expires
  )
  RETURNING id INTO v_pin_id;

  RETURN json_build_object(
    'pin_id',     v_pin_id,
    'pin',        v_pin,
    'expires_at', v_expires
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.issue_editor_pin(UUID, INTEGER, TEXT, UUID, TEXT)
  TO anon, authenticated;
