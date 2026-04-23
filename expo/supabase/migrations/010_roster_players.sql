-- Roster players table for real-time multi-device roster sync
-- Denormalized table: volunteers on any device see check-ins, photos, weights
-- as soon as another volunteer makes a change.
-- Keyed by TEXT id so existing app-generated ids (e.g. `imported-...`) work
-- without conversion.

CREATE TABLE IF NOT EXISTS public.roster_players (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  club TEXT DEFAULT '',
  age_group TEXT DEFAULT '',
  division TEXT DEFAULT '',
  team_name TEXT DEFAULT '',
  date_of_birth TEXT DEFAULT '',
  parent_name TEXT DEFAULT '',
  parent_phone TEXT DEFAULT '',
  is_age_verified BOOLEAN DEFAULT FALSE,
  photo_uri TEXT,
  weight TEXT DEFAULT '',
  checked_in BOOLEAN DEFAULT FALSE,
  checked_in_at TEXT,
  restriction_status TEXT DEFAULT 'none',
  calculated_age_group TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_roster_players_org_id
  ON public.roster_players(org_id);

CREATE INDEX IF NOT EXISTS idx_roster_players_updated_at
  ON public.roster_players(updated_at DESC);

ALTER TABLE public.roster_players ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "roster_players_select" ON public.roster_players;
DROP POLICY IF EXISTS "roster_players_insert" ON public.roster_players;
DROP POLICY IF EXISTS "roster_players_update" ON public.roster_players;
DROP POLICY IF EXISTS "roster_players_delete" ON public.roster_players;

-- Access is already gated in-app by organization code + editor PIN.
-- Allow anon reads/writes so volunteers using the anon key can sync.
CREATE POLICY "roster_players_select" ON public.roster_players
  FOR SELECT USING (true);

CREATE POLICY "roster_players_insert" ON public.roster_players
  FOR INSERT WITH CHECK (true);

CREATE POLICY "roster_players_update" ON public.roster_players
  FOR UPDATE USING (true) WITH CHECK (true);

CREATE POLICY "roster_players_delete" ON public.roster_players
  FOR DELETE USING (true);

-- Enable realtime so other devices receive postgres_changes events
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'roster_players'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.roster_players;
  END IF;
END
$$;

-- Auto-bump updated_at on every change so we can detect the latest writer
CREATE OR REPLACE FUNCTION public.touch_roster_players_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_roster_players_touch ON public.roster_players;
CREATE TRIGGER trg_roster_players_touch
  BEFORE INSERT OR UPDATE ON public.roster_players
  FOR EACH ROW EXECUTE FUNCTION public.touch_roster_players_updated_at();
