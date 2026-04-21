-- Editor PIN access model
-- Admin generates a PIN for an org. Staff redeem the PIN to obtain a
-- time-limited session token. Writes to protected tables require a valid
-- session (via `current_setting('request.editor_session_token')`) or an
-- `is_org_admin` membership.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- Tables
-- ============================================================================

CREATE TABLE IF NOT EXISTS editor_pins (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
CREATE INDEX IF NOT EXISTS idx_editor_sessions_token ON editor_sessions(token_hash);

ALTER TABLE editor_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE editor_sessions ENABLE ROW LEVEL SECURITY;

-- Only admins see pins/sessions from their org; no direct writes from anon
CREATE POLICY "Admins view pins"
  ON editor_pins FOR SELECT
  USING (is_org_admin(org_id));

CREATE POLICY "Admins view sessions"
  ON editor_sessions FOR SELECT
  USING (is_org_admin(org_id));

-- ============================================================================
-- Helpers
-- ============================================================================

-- Returns the org_id associated with the editor session token that the caller
-- passed in the `request.editor_session_token` GUC, or NULL if absent/invalid.
CREATE OR REPLACE FUNCTION current_editor_session_org()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_token TEXT;
  v_hash TEXT;
  v_org UUID;
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
  SELECT is_org_admin(p_org) OR current_editor_session_org() = p_org;
$$;

-- ============================================================================
-- RPCs (called from client with anon key)
-- ============================================================================

-- Admin-only: issue a new PIN. Returns the plaintext PIN ONCE.
CREATE OR REPLACE FUNCTION issue_editor_pin(
  p_org_id UUID,
  p_expires_in_minutes INTEGER DEFAULT 480,
  p_label TEXT DEFAULT NULL,
  p_admin_user_id UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pin TEXT;
  v_pin_id UUID;
  v_expires TIMESTAMPTZ;
BEGIN
  IF NOT is_org_admin(p_org_id) THEN
    RETURN json_build_object('error', 'Unauthorized');
  END IF;

  IF p_expires_in_minutes IS NULL OR p_expires_in_minutes < 5 THEN
    p_expires_in_minutes := 480;
  END IF;

  -- 6-digit PIN (leading zeros allowed)
  v_pin := lpad((floor(random() * 1000000))::int::text, 6, '0');
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
    'pin_id', v_pin_id,
    'pin', v_pin,
    'expires_at', v_expires
  );
END;
$$;

-- Public: redeem a PIN and receive a session token.
CREATE OR REPLACE FUNCTION redeem_editor_pin(
  p_org_id UUID,
  p_pin TEXT,
  p_device_label TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pin RECORD;
  v_hash TEXT;
  v_token TEXT;
  v_token_hash TEXT;
  v_active_sessions INT;
  v_expires TIMESTAMPTZ;
  v_session_id UUID;
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

  v_token := encode(gen_random_bytes(32), 'hex');
  v_token_hash := encode(digest(v_token, 'sha256'), 'hex');
  v_expires := LEAST(v_pin.expires_at, now() + interval '12 hours');

  INSERT INTO editor_sessions (org_id, pin_id, token_hash, device_label, expires_at)
  VALUES (p_org_id, v_pin.id, v_token_hash, p_device_label, v_expires)
  RETURNING id INTO v_session_id;

  RETURN json_build_object(
    'session_id', v_session_id,
    'token', v_token,
    'org_id', p_org_id,
    'expires_at', v_expires
  );
END;
$$;

-- Client-side helper: validate a token (no mutation beyond last_used_at)
CREATE OR REPLACE FUNCTION validate_editor_session(p_token TEXT)
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
    'valid', true,
    'org_id', v_row.org_id,
    'expires_at', v_row.expires_at
  );
END;
$$;

-- Admin-only: revoke a PIN (and cascade-revoke its sessions)
CREATE OR REPLACE FUNCTION revoke_editor_pin(p_pin_id UUID)
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
  IF NOT is_org_admin(v_org) THEN
    RETURN json_build_object('error', 'Unauthorized');
  END IF;

  UPDATE editor_pins SET revoked_at = now() WHERE id = p_pin_id;
  UPDATE editor_sessions
  SET revoked_at = now()
  WHERE pin_id = p_pin_id AND revoked_at IS NULL;

  RETURN json_build_object('success', true);
END;
$$;

-- Admin-only: revoke ALL editor access for an org (e.g. after weigh-in)
CREATE OR REPLACE FUNCTION revoke_all_editor_access(p_org_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT is_org_admin(p_org_id) THEN
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

GRANT EXECUTE ON FUNCTION issue_editor_pin        TO anon, authenticated;
GRANT EXECUTE ON FUNCTION redeem_editor_pin       TO anon, authenticated;
GRANT EXECUTE ON FUNCTION validate_editor_session TO anon, authenticated;
GRANT EXECUTE ON FUNCTION revoke_editor_pin       TO anon, authenticated;
GRANT EXECUTE ON FUNCTION revoke_all_editor_access TO anon, authenticated;
GRANT EXECUTE ON FUNCTION has_editor_access        TO anon, authenticated;
GRANT EXECUTE ON FUNCTION current_editor_session_org TO anon, authenticated;

-- ============================================================================
-- Tighten RLS on protected tables
-- ============================================================================

-- Players: allow editor-session writes within the org
DROP POLICY IF EXISTS "Admins can insert players" ON players;
DROP POLICY IF EXISTS "Admins can update players" ON players;
DROP POLICY IF EXISTS "Admins can delete players" ON players;

CREATE POLICY "Admins or editors insert players"
  ON players FOR INSERT
  WITH CHECK (has_editor_access(org_id));

CREATE POLICY "Admins or editors update players"
  ON players FOR UPDATE
  USING (has_editor_access(org_id));

CREATE POLICY "Admins delete players"
  ON players FOR DELETE
  USING (is_org_admin(org_id));

-- Event check-ins: editor sessions can insert/update for their org
DROP POLICY IF EXISTS "Members can insert check-ins" ON event_check_ins;
DROP POLICY IF EXISTS "Admins can update check-ins" ON event_check_ins;

CREATE POLICY "Editors insert check-ins"
  ON event_check_ins FOR INSERT
  WITH CHECK (
    event_id IN (
      SELECT e.id FROM events e WHERE has_editor_access(e.org_id)
    )
  );

CREATE POLICY "Editors update check-ins"
  ON event_check_ins FOR UPDATE
  USING (
    event_id IN (
      SELECT e.id FROM events e WHERE has_editor_access(e.org_id)
    )
  );
