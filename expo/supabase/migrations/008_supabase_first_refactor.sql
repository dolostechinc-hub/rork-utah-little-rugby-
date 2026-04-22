-- Supabase-first refactor: lookup tables, extended players columns, check_in_events.
-- Additive migration. Safe to run once.

-- ------------------------------------------------------------------
-- Lookup tables
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clubs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS age_groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS divisions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed baseline age groups & divisions
INSERT INTO age_groups (code) VALUES ('U6'),('U8'),('U10'),('U12'),('U14')
ON CONFLICT (code) DO NOTHING;

INSERT INTO divisions (name) VALUES ('Restricted'),('Open')
ON CONFLICT (name) DO NOTHING;

-- ------------------------------------------------------------------
-- Extend existing teams table with normalized FKs
-- ------------------------------------------------------------------
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS club_id UUID REFERENCES clubs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS age_group_id UUID REFERENCES age_groups(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS division_id UUID REFERENCES divisions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS team_name TEXT;

-- Mirror existing team "name" into new "team_name" column if present
UPDATE teams SET team_name = name WHERE team_name IS NULL;

CREATE INDEX IF NOT EXISTS idx_teams_club_id ON teams(club_id);
CREATE INDEX IF NOT EXISTS idx_teams_age_group_id ON teams(age_group_id);

-- ------------------------------------------------------------------
-- Extend existing players table with Supabase-first fields
-- ------------------------------------------------------------------
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS external_player_id TEXT,
  ADD COLUMN IF NOT EXISTS club_id UUID REFERENCES clubs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS age_group_id UUID REFERENCES age_groups(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS division_id UUID REFERENCES divisions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS current_weight_lbs NUMERIC,
  ADD COLUMN IF NOT EXISTS checked_in BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS photo_path TEXT,
  ADD COLUMN IF NOT EXISTS source_sheet_id TEXT,
  ADD COLUMN IF NOT EXISTS source_row_number INTEGER;

CREATE INDEX IF NOT EXISTS idx_players_club_id ON players(club_id);
CREATE INDEX IF NOT EXISTS idx_players_age_group_id ON players(age_group_id);
CREATE INDEX IF NOT EXISTS idx_players_checked_in ON players(checked_in);
CREATE INDEX IF NOT EXISTS idx_players_external ON players(external_player_id);

-- ------------------------------------------------------------------
-- check_in_events audit table
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS check_in_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  measured_weight_lbs NUMERIC,
  age_verified BOOLEAN DEFAULT FALSE,
  restriction_status TEXT DEFAULT 'none',
  photo_path TEXT,
  checked_in_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_check_in_events_player_id ON check_in_events(player_id);
CREATE INDEX IF NOT EXISTS idx_check_in_events_checked_in_at ON check_in_events(checked_in_at);

-- ------------------------------------------------------------------
-- Monday-safe RLS: allow anon to read/write lookup + live check-in data.
-- NOTE: Tighten these once auth rollout is complete.
-- ------------------------------------------------------------------
ALTER TABLE clubs ENABLE ROW LEVEL SECURITY;
ALTER TABLE age_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE divisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE check_in_events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "anon read clubs" ON clubs FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "anon write clubs" ON clubs FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "anon read age_groups" ON age_groups FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "anon write age_groups" ON age_groups FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "anon read divisions" ON divisions FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "anon write divisions" ON divisions FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "anon read check_in_events" ON check_in_events FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "anon insert check_in_events" ON check_in_events FOR INSERT WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Loosen players/teams for the volunteer check-in hot path (Monday-safe).
DO $$ BEGIN
  CREATE POLICY "volunteer read players" ON players FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "volunteer update players" ON players FOR UPDATE USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "volunteer insert players" ON players FOR INSERT WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "volunteer read teams" ON teams FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "volunteer write teams" ON teams FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------------
-- Storage: private bucket `player-photos` (hyphen, per refactor spec).
-- The legacy public `player_photos` bucket still exists from migration 004.
-- ------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('player-photos', 'player-photos', false)
ON CONFLICT (id) DO NOTHING;

DO $$ BEGIN
  CREATE POLICY "read player-photos" ON storage.objects
    FOR SELECT USING (bucket_id = 'player-photos');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "upload player-photos" ON storage.objects
    FOR INSERT WITH CHECK (bucket_id = 'player-photos');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "update player-photos" ON storage.objects
    FOR UPDATE USING (bucket_id = 'player-photos');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------------
-- Enable realtime on players so roster screens can subscribe.
-- ------------------------------------------------------------------
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE players;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE check_in_events;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
