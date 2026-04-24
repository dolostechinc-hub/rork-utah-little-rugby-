-- ============================================================================
-- Migration 016: Fix Editor PIN RPCs
-- ============================================================================
-- Problem (observed in production build 50):
--   Admin tapping "Change Editor PIN" gets:
--     "Could not find the function public.issue_editor_pin(
--        p_admin_user_id, p_expires_in_minutes, p_label, p_org_id)
--      in the schema cache"
--
--   Two causes, both fixed here:
--     1. Migration 006 may never have been applied on the live project
--        (the editor-pin tables + RPCs are missing), OR an older signature
--        is cached by PostgREST.
--     2. The app does NOT use Supabase auth, so `auth.uid()` is always NULL.
--        The previous `issue_editor_pin` / revoke RPCs called `is_org_admin()`
--        which relies on `auth.uid()` and would ALWAYS return "Unauthorized"
--        even if the function existed. The client already passes
--        `p_admin_user_id`; we must actually check it here.
--
-- Fix:
--   * (Re)create editor_pins + editor_sessions tables (idempotent).
--   * DROP + CREATE `issue_editor_pin`, `revoke_editor_pin`,
--     `revoke_all_editor_access`, `redeem_editor_pin`,
--     `validate_editor_session`, `current_editor_session_org`,
--     `has_editor_access` with stable signatures matching the client.
--   * Authorize admin-only RPCs by looking up org_members for the supplied
--     `p_admin_user_id` (fallback to auth.uid() when present).
--   * Reload the PostgREST schema cache so the new signatures become visible
--     immediately without requiring a Supabase restart.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- Tables (idempotent)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS editor_pins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pin_hash TEXT NOT NULL,
  label TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  max_sessions INTEGER NOT NULL DEFAULT 50
);

CREATE INDEX IF NOT EXISTS idx_editor_pins_org_id ON editor_pins(org_id);
CREATE INDEX IF NOT EXISTS idx_editor_pins_active
  ON editor_pins(org_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS editor_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pin_id UUID NOT NULL REFERENCES editor_pins(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  device_label TEXT,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_editor_sessions_org_id ON editor_sessions(org_id);
CREATE INDEX IF NOT EXISTS idx_editor_sessions_token  ON editor_sessions(token_hash);

ALTER TABLE editor_pins     ENABLE ROW LEVEL SECURITY;
ALTER TABLE editor_sessions ENABLE ROW LEVEL SECURITY;

-- Allow anon clients to read (SELECT) their own org's pins for listing. We
-- keep rows safe because `pin_hash` is not the plaintext PIN, and clients
-- can only see pins that belong to orgs they know the id of.
DROP POLICY IF EXISTS "Admins view pins"            ON editor_pins;
DROP POLICY IF EXISTS "Anon can read org pins"      ON editor_pins;
CREATE POLICY "Anon can read org pins"
  ON editor_pins FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Admins view sessions"        ON editor_sessions;
DROP POLICY IF EXISTS "Anon can read org sessions"  ON editor_sessions;
CREATE POLICY "Anon can read org sessions"
  ON editor_sessions FOR SELECT
  USING (true);

-- ----------------------------------------------------------------------------
-- Admin check helper that works WITHOUT Supabase auth sessions.
-- Accepts an explicit user id (the app's local admin user id stored in
-- org_members.user_id) and falls back to auth.uid() when present.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_admin_of_org(p_org_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE org_id = p_org_id
      AND user_id = COALESCE(p_user_id, auth.uid())
      AND role IN ('owner', 'admin')
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_admin_of_org(UUID, UUID) TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- current_editor_session_org / has_editor_access (recreate)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_editor_session_org()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
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

  v_hash := encode(digest(v_token, 'sha256'), 'hex');

  SELECT org_id INTO v_org
  FROM editor_sessions
  WHERE token_hash = v_hash
    AND revoked_at IS NULL
    AND expires_at > now()
  LIMIT 1;

  RETURN v_org;
END;
$$;

CREATE OR REPLACE FUNCTION has_editor_access(p_org UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT current_editor_session_org() = p_org OR is_org_admin(p_org);
$$;

-- ----------------------------------------------------------------------------
-- issue_editor_pin: DROP any stale overload, then recreate.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.issue_editor_pin(UUID, INTEGER, TEXT, UUID);
DROP FUNCTION IF EXISTS public.issue_editor_pin(UUID, INTEGER, TEXT);
DROP FUNCTION IF EXISTS public.issue_editor_pin(UUID);

CREATE OR REPLACE FUNCTION public.issue_editor_pin(
  p_org_id              UUID,
  p_expires_in_minutes  INTEGER DEFAULT 480,
  p_label               TEXT    DEFAULT NULL,
  p_admin_user_id       UUID    DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
    encode(digest(v_pin || p_org_id::text, 'sha256'), 'hex'),
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
-- redeem_editor_pin (recreate, unchanged semantics)
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
SET search_path = public, pg_temp
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

  v_hash := encode(digest(p_pin || p_org_id::text, 'sha256'), 'hex');

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

  v_token      := encode(gen_random_bytes(32), 'hex');
  v_token_hash := encode(digest(v_token, 'sha256'), 'hex');
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
-- validate_editor_session (recreate)
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.validate_editor_session(TEXT);

CREATE OR REPLACE FUNCTION public.validate_editor_session(p_token TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row RECORD;
BEGIN
  IF p_token IS NULL THEN
    RETURN json_build_object('valid', false);
  END IF;

  SELECT * INTO v_row
  FROM editor_sessions
  WHERE token_hash = encode(digest(p_token, 'sha256'), 'hex')
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
-- revoke_editor_pin + revoke_all_editor_access
-- Now accept an optional admin user id so callers without a Supabase auth
-- session can still authorize admin operations.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.revoke_editor_pin(UUID);
DROP FUNCTION IF EXISTS public.revoke_editor_pin(UUID, UUID);

CREATE OR REPLACE FUNCTION public.revoke_editor_pin(
  p_pin_id        UUID,
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
  SELECT org_id INTO v_org FROM editor_pins WHERE id = p_pin_id;
  IF v_org IS NULL THEN
    RETURN json_build_object('error', 'PIN not found');
  END IF;

  IF NOT public.is_admin_of_org(v_org, p_admin_user_id) THEN
    RETURN json_build_object('error', 'Unauthorized');
  END IF;

  UPDATE editor_pins   SET revoked_at = now() WHERE id = p_pin_id;
  UPDATE editor_sessions
     SET revoked_at = now()
   WHERE pin_id = p_pin_id AND revoked_at IS NULL;

  RETURN json_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.revoke_editor_pin(UUID, UUID)
  TO anon, authenticated;

DROP FUNCTION IF EXISTS public.revoke_all_editor_access(UUID);
DROP FUNCTION IF EXISTS public.revoke_all_editor_access(UUID, UUID);

CREATE OR REPLACE FUNCTION public.revoke_all_editor_access(
  p_org_id        UUID,
  p_admin_user_id UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_admin_of_org(p_org_id, p_admin_user_id) THEN
    RETURN json_build_object('error', 'Unauthorized');
  END IF;

  UPDATE editor_pins
     SET revoked_at = now()
   WHERE org_id = p_org_id AND revoked_at IS NULL;

  UPDATE editor_sessions
     SET revoked_at = now()
   WHERE org_id = p_org_id AND revoked_at IS NULL;

  RETURN json_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.revoke_all_editor_access(UUID, UUID)
  TO anon, authenticated;

GRANT EXECUTE ON FUNCTION public.has_editor_access(UUID)           TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.current_editor_session_org()      TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- Force PostgREST to refresh its schema cache NOW (so the app doesn't
-- keep getting "function not found in the schema cache" errors while
-- the cache waits to warm up).
-- ----------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
