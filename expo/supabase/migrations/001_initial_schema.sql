-- Youth Sports Registration App - Initial Schema
-- This migration creates the base tables for multi-tenant organization management

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Organizations table
CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,
  logo_uri TEXT,
  primary_color TEXT DEFAULT '#0B7A4B',
  owner_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Organization members table (links users to orgs with roles)
CREATE TABLE IF NOT EXISTS org_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'coach', 'volunteer', 'viewer')),
  email TEXT,
  name TEXT,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(org_id, user_id)
);

-- Teams table
CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  age_group TEXT NOT NULL,
  division TEXT NOT NULL,
  coach_name TEXT,
  coach_phone TEXT,
  coach_email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Players table
CREATE TABLE IF NOT EXISTS players (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  club TEXT,
  age_group TEXT NOT NULL,
  division TEXT NOT NULL,
  date_of_birth DATE,
  parent_name TEXT,
  parent_phone TEXT,
  is_age_verified BOOLEAN DEFAULT FALSE,
  photo_uri TEXT,
  weight TEXT,
  jersey_number TEXT,
  restriction_status TEXT DEFAULT 'none',
  calculated_age_group TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Events table
CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  location TEXT,
  start_date TIMESTAMPTZ NOT NULL,
  end_date TIMESTAMPTZ,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'completed', 'cancelled')),
  description TEXT,
  check_in_open BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Event teams (links teams to events)
CREATE TABLE IF NOT EXISTS event_teams (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  team_name TEXT NOT NULL,
  org_name TEXT,
  is_home_team BOOLEAN DEFAULT FALSE,
  checked_in_count INTEGER DEFAULT 0,
  total_players INTEGER DEFAULT 0,
  UNIQUE(event_id, team_id)
);

-- Event check-ins table
CREATE TABLE IF NOT EXISTS event_check_ins (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  checked_in_by UUID,
  checked_in_at TIMESTAMPTZ DEFAULT NOW(),
  photo_uri TEXT,
  weight_verified BOOLEAN DEFAULT FALSE,
  age_verified BOOLEAN DEFAULT FALSE,
  sync_status TEXT DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending', 'failed')),
  UNIQUE(event_id, player_id)
);

-- Organization privacy settings
CREATE TABLE IF NOT EXISTS org_privacy_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID UNIQUE NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  show_full_name BOOLEAN DEFAULT FALSE,
  show_jersey_number BOOLEAN DEFAULT TRUE,
  show_birth_year BOOLEAN DEFAULT TRUE,
  show_photo BOOLEAN DEFAULT FALSE,
  show_weight BOOLEAN DEFAULT FALSE,
  verification_pass_duration_minutes INTEGER DEFAULT 240,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Verification passes table
CREATE TABLE IF NOT EXISTS verification_passes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  issuing_team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  issuing_org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID,
  is_revoked BOOLEAN DEFAULT FALSE,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID
);

-- Verification views (audit log)
CREATE TABLE IF NOT EXISTS verification_views (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pass_id UUID NOT NULL REFERENCES verification_passes(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  viewed_team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  viewer_user_id UUID,
  viewer_ip TEXT,
  viewed_at TIMESTAMPTZ DEFAULT NOW(),
  player_count INTEGER DEFAULT 0
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_org_members_org_id ON org_members(org_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user_id ON org_members(user_id);
CREATE INDEX IF NOT EXISTS idx_teams_org_id ON teams(org_id);
CREATE INDEX IF NOT EXISTS idx_players_org_id ON players(org_id);
CREATE INDEX IF NOT EXISTS idx_players_team_id ON players(team_id);
CREATE INDEX IF NOT EXISTS idx_events_org_id ON events(org_id);
CREATE INDEX IF NOT EXISTS idx_event_teams_event_id ON event_teams(event_id);
CREATE INDEX IF NOT EXISTS idx_event_check_ins_event_id ON event_check_ins(event_id);
CREATE INDEX IF NOT EXISTS idx_verification_passes_code ON verification_passes(code);
CREATE INDEX IF NOT EXISTS idx_verification_passes_event_id ON verification_passes(event_id);
CREATE INDEX IF NOT EXISTS idx_verification_views_pass_id ON verification_views(pass_id);
