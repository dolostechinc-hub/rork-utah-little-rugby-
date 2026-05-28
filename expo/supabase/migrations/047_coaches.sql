-- ============================================================================
-- Migration 047: Coaches table + coach_teams junction
-- ============================================================================
-- Coaches are a separate entity from players. They can be assigned to
-- multiple teams (across clubs/age-groups/divisions) and have a simple
-- check-in + certification status. This mirrors the roster_players realtime
-- pattern so volunteers on any device see coach check-ins live.
-- ============================================================================

BEGIN;

-- 1. Coaches table
CREATE TABLE IF NOT EXISTS public.coaches (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL,
  first_name       TEXT NOT NULL DEFAULT '',
  last_name        TEXT NOT NULL DEFAULT '',
  photo_uri        TEXT,
  is_certified     BOOLEAN NOT NULL DEFAULT FALSE,
  checked_in       BOOLEAN NOT NULL DEFAULT FALSE,
  checked_in_at    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_coaches_org_id
  ON public.coaches(org_id);

-- 2. Coach-team junction (one coach can belong to multiple teams)
CREATE TABLE IF NOT EXISTS public.coach_teams (
  id         TEXT PRIMARY KEY,
  coach_id   TEXT NOT NULL REFERENCES public.coaches(id) ON DELETE CASCADE,
  org_id     TEXT NOT NULL,
  club       TEXT NOT NULL DEFAULT '',
  age_group  TEXT NOT NULL DEFAULT '',
  division   TEXT NOT NULL DEFAULT '',
  team_name  TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_coach_teams_coach_id
  ON public.coach_teams(coach_id);

CREATE INDEX IF NOT EXISTS idx_coach_teams_org_id
  ON public.coach_teams(org_id);

-- 3. RLS — same anon-access pattern as roster_players
ALTER TABLE public.coaches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coach_teams ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "coaches_select" ON public.coaches;
CREATE POLICY "coaches_select" ON public.coaches FOR SELECT USING (true);

DROP POLICY IF EXISTS "coaches_insert" ON public.coaches;
CREATE POLICY "coaches_insert" ON public.coaches FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "coaches_update" ON public.coaches;
CREATE POLICY "coaches_update" ON public.coaches FOR UPDATE USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "coaches_delete" ON public.coaches;
CREATE POLICY "coaches_delete" ON public.coaches FOR DELETE USING (true);

DROP POLICY IF EXISTS "coach_teams_select" ON public.coach_teams;
CREATE POLICY "coach_teams_select" ON public.coach_teams FOR SELECT USING (true);

DROP POLICY IF EXISTS "coach_teams_insert" ON public.coach_teams;
CREATE POLICY "coach_teams_insert" ON public.coach_teams FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "coach_teams_update" ON public.coach_teams;
CREATE POLICY "coach_teams_update" ON public.coach_teams FOR UPDATE USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "coach_teams_delete" ON public.coach_teams;
CREATE POLICY "coach_teams_delete" ON public.coach_teams FOR DELETE USING (true);

-- 4. Realtime publication
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'coaches'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.coaches;
  END IF;
END $$;

-- 5. Auto-bump updated_at
CREATE OR REPLACE FUNCTION public.touch_coaches_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_coaches_touch ON public.coaches;
CREATE TRIGGER trg_coaches_touch
  BEFORE INSERT OR UPDATE ON public.coaches
  FOR EACH ROW EXECUTE FUNCTION public.touch_coaches_updated_at();

COMMIT;
