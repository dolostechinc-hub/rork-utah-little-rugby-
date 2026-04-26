-- ============================================================================
-- Migration 021: Fix "function digest(text, unknown) does not exist"
-- ============================================================================
-- In Supabase, the pgcrypto extension is installed in the `extensions` schema,
-- not `public`. Our editor-pin RPCs are SECURITY DEFINER with
-- `SET search_path = public, pg_temp`, which means `digest()` and
-- `gen_random_bytes()` from pgcrypto are NOT visible inside the function body.
--
-- That surfaces as: `function digest(text, unknown) does not exist` the moment
-- an admin taps "Generate Editor PIN".
--
-- Fix: recreate every editor-pin RPC with `search_path = public, extensions,
-- pg_temp` so pgcrypto functions resolve correctly. We also keep an explicit
-- `CREATE EXTENSION ... WITH SCHEMA extensions` to make sure the extension is
-- where we expect it.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA extensions;

-- ----------------------------------------------------------------------------
-- current_editor_session_org
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_editor_session_org()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_token TEXT;
  v_hash  TEXT;
  v_org   UUID;
BEGIN
  BEGIN
    v_token := current_setting('request.editor_session_token', true);
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;

  IF v_token IS NULL OR length(v_token) = 0 THEN
    RETURN NULL;
  END IF;

  v_hash := encode(extensions.digest(v_token, 'sha256'), 'hex');

  SELECT org_id INTO v_org
  FROM editor_sessions
  WHERE token_hash = v_hash
    AND revoked_at IS NULL
    AND expires_at > now()
  LIMIT 1;

  RETURN v_org;
END;
$$;

GRANT EXECUTE ON FUNCTION public.current_editor_session_org() TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- issue_editor_pin
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.issue_editor_pin(UUID, INTEGER, TEXT, UUID);

CREATE OR REPLACE FUNCTION public.issue_editor_pin(
  p_org_id              UUID,
  p_expires_in_minutes  INTEGER DEFAULT 480,
  p_label               TEXT    DEFAULT NULL,
  p_admin_user_id       UUID    DEFAULT NULL
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
BEGIN
  IF NOT public.is_admin_of_org(p_org_id, p_admin_user_id) THEN
    RETURN json_build_object('error', 'Unauthorized');
  END IF;

  IF p_expires_in_minutes IS NULL OR p_expires_in_minutes < 5 THEN
    p_expires_in_minutes := 480;
  END IF;

  v_pin     := lpad((floor(random() * 1000000))::int::text, 6, '0');
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

GRANT EXECUTE ON FUNCTION public.issue_editor_pin(UUID, INTEGER, TEXT, UUID)
  TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- redeem_editor_pin
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.redeem_editor_pin(UUID, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.redeem_editor_pin(
  p_org_id       UUID,
  p_pin          TEXT,
  p_device_label TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_pin              RECORD;
  v_hash             TEXT;
  v_token            TEXT;
  v_token_hash       TEXT;
  v_active_sessions  INT;
  v_expires          TIMESTAMPTZ;
  v_session_id       UUID;
BEGIN
  IF p_pin IS NULL OR length(p_pin) < 4 THEN
    RETURN json_build_object('error', 'Invalid PIN');
  END IF;

  v_hash := encode(extensions.digest(p_pin || p_org_id::text, 'sha256'), 'hex');

  SELECT * INTO v_pin
  FROM editor_pins
  WHERE org_id = p_org_id
    AND pin_hash = v_hash
    AND revoked_at IS NULL
    AND expires_at > now()
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_pin IS NULL THEN
    RETURN json_build_object('error', 'Invalid or expired PIN');
  END IF;

  SELECT COUNT(*) INTO v_active_sessions
  FROM editor_sessions
  WHERE pin_id = v_pin.id
    AND revoked_at IS NULL
    AND expires_at > now();

  IF v_active_sessions >= v_pin.max_sessions THEN
    RETURN json_build_object('error', 'Session limit reached for this PIN');
  END IF;

  v_token      := encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash := encode(extensions.digest(v_token, 'sha256'), 'hex');
  v_expires    := LEAST(v_pin.expires_at, now() + interval '12 hours');

  INSERT INTO editor_sessions (org_id, pin_id, token_hash, device_label, expires_at)
  VALUES (p_org_id, v_pin.id, v_token_hash, p_device_label, v_expires)
  RETURNING id INTO v_session_id;

  RETURN json_build_object(
    'session_id', v_session_id,
    'token',      v_token,
    'org_id',     p_org_id,
    'expires_at', v_expires
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.redeem_editor_pin(UUID, TEXT, TEXT)
  TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- validate_editor_session
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.validate_editor_session(TEXT);

CREATE OR REPLACE FUNCTION public.validate_editor_session(p_token TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_row RECORD;
BEGIN
  IF p_token IS NULL THEN
    RETURN json_build_object('valid', false);
  END IF;

  SELECT * INTO v_row
  FROM editor_sessions
  WHERE token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    AND revoked_at IS NULL
    AND expires_at > now()
  LIMIT 1;

  IF v_row IS NULL THEN
    RETURN json_build_object('valid', false);
  END IF;

  UPDATE editor_sessions
  SET last_used_at = now()
  WHERE id = v_row.id;

  RETURN json_build_object(
    'valid',      true,
    'org_id',     v_row.org_id,
    'expires_at', v_row.expires_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.validate_editor_session(TEXT)
  TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- Force PostgREST to refresh its schema cache.
-- ----------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
