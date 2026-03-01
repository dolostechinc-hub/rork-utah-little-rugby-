-- Youth Sports Registration App - Verification Functions
-- Edge function helpers for secure roster verification

-- Function to create a verification pass
CREATE OR REPLACE FUNCTION create_verification_pass(
  p_event_id UUID,
  p_team_id UUID,
  p_duration_minutes INTEGER DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  v_org_id UUID;
  v_duration INTEGER;
  v_code TEXT;
  v_token TEXT;
  v_pass_id UUID;
  v_expires_at TIMESTAMPTZ;
BEGIN
  -- Get the org_id from the team
  SELECT org_id INTO v_org_id FROM teams WHERE id = p_team_id;
  
  IF v_org_id IS NULL THEN
    RETURN json_build_object('error', 'Team not found');
  END IF;
  
  -- Check if user is a member of the org
  IF NOT is_org_member(v_org_id) THEN
    RETURN json_build_object('error', 'Unauthorized');
  END IF;
  
  -- Get duration from privacy settings or use provided value
  IF p_duration_minutes IS NULL THEN
    SELECT COALESCE(verification_pass_duration_minutes, 240) 
    INTO v_duration 
    FROM org_privacy_settings 
    WHERE org_id = v_org_id;
    
    IF v_duration IS NULL THEN
      v_duration := 240;
    END IF;
  ELSE
    v_duration := p_duration_minutes;
  END IF;
  
  -- Generate 6-character alphanumeric code
  v_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
  
  -- Generate token hash
  v_token := encode(digest(v_code || p_event_id::text || p_team_id::text || now()::text, 'sha256'), 'hex');
  
  -- Calculate expiration
  v_expires_at := now() + (v_duration || ' minutes')::interval;
  
  -- Insert the pass
  INSERT INTO verification_passes (
    event_id, issuing_team_id, issuing_org_id, code, token_hash, 
    expires_at, created_by
  )
  VALUES (
    p_event_id, p_team_id, v_org_id, v_code, v_token,
    v_expires_at, auth.uid()
  )
  RETURNING id INTO v_pass_id;
  
  RETURN json_build_object(
    'id', v_pass_id,
    'code', v_code,
    'expires_at', v_expires_at,
    'duration_minutes', v_duration
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to redeem a verification pass and get limited roster data
CREATE OR REPLACE FUNCTION redeem_verification_pass(p_code TEXT)
RETURNS JSON AS $$
DECLARE
  v_pass RECORD;
  v_privacy RECORD;
  v_team RECORD;
  v_event RECORD;
  v_roster JSON;
BEGIN
  -- Find the pass
  SELECT * INTO v_pass 
  FROM verification_passes 
  WHERE code = upper(p_code) 
    AND is_revoked = FALSE 
    AND expires_at > now();
  
  IF v_pass IS NULL THEN
    RETURN json_build_object('error', 'Invalid or expired pass');
  END IF;
  
  -- Get privacy settings
  SELECT * INTO v_privacy 
  FROM org_privacy_settings 
  WHERE org_id = v_pass.issuing_org_id;
  
  -- Use defaults if no privacy settings exist
  IF v_privacy IS NULL THEN
    v_privacy := ROW(
      NULL, v_pass.issuing_org_id, FALSE, TRUE, TRUE, FALSE, FALSE, 240, now()
    )::org_privacy_settings;
  END IF;
  
  -- Get team and event info
  SELECT * INTO v_team FROM teams WHERE id = v_pass.issuing_team_id;
  SELECT * INTO v_event FROM events WHERE id = v_pass.event_id;
  
  -- Build limited roster based on privacy settings
  SELECT json_agg(
    json_build_object(
      'id', p.id,
      'displayName', 
        CASE WHEN v_privacy.show_full_name 
          THEN p.first_name || ' ' || p.last_name
          ELSE p.first_name || ' ' || left(p.last_name, 1) || '.'
        END,
      'jerseyNumber', 
        CASE WHEN v_privacy.show_jersey_number THEN p.jersey_number ELSE NULL END,
      'birthYear',
        CASE WHEN v_privacy.show_birth_year THEN extract(year from p.date_of_birth)::text ELSE NULL END,
      'photoUri',
        CASE WHEN v_privacy.show_photo THEN p.photo_uri ELSE NULL END,
      'weight',
        CASE WHEN v_privacy.show_weight THEN p.weight ELSE NULL END,
      'ageGroup', COALESCE(p.calculated_age_group, p.age_group),
      'division', p.division
    )
  ) INTO v_roster
  FROM players p
  WHERE p.team_id = v_pass.issuing_team_id
    OR (p.org_id = v_pass.issuing_org_id AND p.age_group = v_team.age_group);
  
  -- Log the verification view
  INSERT INTO verification_views (
    pass_id, event_id, viewed_team_id, viewer_user_id, player_count
  )
  VALUES (
    v_pass.id, v_pass.event_id, v_pass.issuing_team_id, auth.uid(),
    COALESCE(json_array_length(v_roster), 0)
  );
  
  RETURN json_build_object(
    'pass', json_build_object(
      'id', v_pass.id,
      'code', v_pass.code,
      'expiresAt', v_pass.expires_at
    ),
    'team', json_build_object(
      'id', v_team.id,
      'name', v_team.name
    ),
    'event', json_build_object(
      'id', v_event.id,
      'name', v_event.name
    ),
    'roster', COALESCE(v_roster, '[]'::json)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to revoke a verification pass
CREATE OR REPLACE FUNCTION revoke_verification_pass(p_pass_id UUID)
RETURNS JSON AS $$
DECLARE
  v_pass RECORD;
BEGIN
  SELECT * INTO v_pass FROM verification_passes WHERE id = p_pass_id;
  
  IF v_pass IS NULL THEN
    RETURN json_build_object('error', 'Pass not found');
  END IF;
  
  IF NOT is_org_member(v_pass.issuing_org_id) THEN
    RETURN json_build_object('error', 'Unauthorized');
  END IF;
  
  UPDATE verification_passes
  SET is_revoked = TRUE, revoked_at = now(), revoked_by = auth.uid()
  WHERE id = p_pass_id;
  
  RETURN json_build_object('success', TRUE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION create_verification_pass TO authenticated;
GRANT EXECUTE ON FUNCTION redeem_verification_pass TO anon, authenticated;
GRANT EXECUTE ON FUNCTION revoke_verification_pass TO authenticated;
