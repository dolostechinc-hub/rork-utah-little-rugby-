-- ============================================================================
-- Migration 025: Canonical clubs table + backfill of legacy free-text clubs
-- ============================================================================
-- Why:
--   Today players.club / roster_players.club are free-text. The audit found a
--   long tail of variants (case differences, "Little X" vs "X", abbreviations
--   like 'MVP' / 'Mountain Valley Powerhouse'). This makes filters,
--   reporting and roster grouping unreliable.
--
-- What:
--   - public.clubs table: one global, canonical list of league clubs.
--   - public.clubs is read-only for anon (volunteers); writes go through
--     Supabase Studio / service_role for now (no in-app admin UI yet).
--   - players.club_id, roster_players.club_id: FK references to clubs(id),
--     nullable so legacy rows that don't match any canonical name don't
--     fail. Index on each so org dashboards can group cheaply.
--   - Backfill: maps every existing free-text value to its canonical club
--     using a normalized (case + collapsed-whitespace) match.
--   - Rewrites the legacy text 'club' column to the canonical name so all
--     existing reads (realtime, fetchRoster, etc.) surface clean values.
--   - BEFORE INSERT/UPDATE trigger on roster_players that re-derives
--     club_id from club whenever the text column is written, so the app
--     can keep writing player.club (a name string) without having to
--     know the FK. The strict picker on the client guarantees the name
--     resolves.
--
-- Decisions encoded here (locked in product Q&A on 2026-05-04):
--   - Global table (one canonical list across all orgs).
--   - Strict picker in app: users must pick from the list.
--   - 'Little X' is NOT a separate club. Youth status is implied by the
--     player's age_group field, so 'Brighton' and 'Little Brighton' both
--     map to the same canonical 'Brighton' club row.
--   - 'MVP' merges into 'Mountain Valley Powerhouse'.
--   - 'Provo' merges into 'Provo Steelers'.
--   - 'Mountain Ridge Black' merges into 'Mountain Ridge'.
--   - 'Little Cache Valley Pirates' merges into 'Cache Valley'.
--
-- Safety:
--   - Idempotent (CREATE TABLE IF NOT EXISTS, INSERT ... ON CONFLICT DO
--     NOTHING, ADD COLUMN IF NOT EXISTS, DROP/CREATE TRIGGER, etc.).
--   - No temp tables (Supabase SQL Editor runs through pgbouncer in
--     transaction-pool mode, which does NOT preserve TEMP tables between
--     statements even within an explicit BEGIN/COMMIT block — every
--     statement can land on a different backend connection). The
--     source -> canonical mapping is therefore inlined as VALUES inside
--     each UPDATE that needs it.
-- ============================================================================


CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ----------------------------------------------------------------------------
-- 1. Canonical clubs table.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.clubs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT UNIQUE NOT NULL,
  short_name  TEXT,
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Case-insensitive lookup is hot path (derive trigger + app fetch).
CREATE INDEX IF NOT EXISTS idx_clubs_name_lower
  ON public.clubs(lower(name));

ALTER TABLE public.clubs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "clubs_select" ON public.clubs;
CREATE POLICY "clubs_select" ON public.clubs FOR SELECT USING (true);

-- No insert/update/delete policies for anon. Writes happen via Supabase
-- Studio / service_role until an admin UI exists. Add follow-up policies
-- there.
DROP POLICY IF EXISTS "clubs_insert" ON public.clubs;
DROP POLICY IF EXISTS "clubs_update" ON public.clubs;
DROP POLICY IF EXISTS "clubs_delete" ON public.clubs;

CREATE OR REPLACE FUNCTION public.touch_clubs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_clubs_touch ON public.clubs;
CREATE TRIGGER trg_clubs_touch
  BEFORE UPDATE ON public.clubs
  FOR EACH ROW EXECUTE FUNCTION public.touch_clubs_updated_at();

-- ----------------------------------------------------------------------------
-- 2. Seed canonical clubs (idempotent).
-- ----------------------------------------------------------------------------
INSERT INTO public.clubs (name) VALUES
  ('American Fork'),
  ('Brighton'),
  ('Cache Valley'),
  ('Cavemen Rugby'),
  ('Eagle Mountain'),
  ('East'),
  ('Herriman'),
  ('Highland'),
  ('Kearns'),
  ('LCA'),
  ('Majestics'),
  ('Mountain Ridge'),
  ('Mountain Valley Powerhouse'),
  ('Mountain View'),
  ('Olympus'),
  ('Orem'),
  ('Pleasant Grove'),
  ('Provo Steelers'),
  ('Richfield Broncos'),
  ('Salt Lake Valley Rhinos'),
  ('Skyline'),
  ('South Davis'),
  ('Springville'),
  ('Tooele'),
  ('United'),
  ('War Frog'),
  ('Wasatch'),
  ('West Valley Warriors'),
  ('Westlake Drua'),
  ('Westside Lions')
ON CONFLICT (name) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 3. Add club_id FK to players and roster_players (nullable). Indexed for
--    org dashboards / club roll-ups.
-- ----------------------------------------------------------------------------
ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS club_id UUID REFERENCES public.clubs(id) ON DELETE SET NULL;

ALTER TABLE public.roster_players
  ADD COLUMN IF NOT EXISTS club_id UUID REFERENCES public.clubs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_players_club_id
  ON public.players(club_id);
CREATE INDEX IF NOT EXISTS idx_roster_players_club_id
  ON public.roster_players(club_id);

-- ----------------------------------------------------------------------------
-- 4. Backfill club_id on legacy rows using a case- and whitespace-insensitive
--    match. The source -> canonical mapping is inlined as a VALUES list in
--    each UPDATE (no TEMP table — see header note about pgbouncer
--    transaction pooling). The list is duplicated rather than shared via a
--    data-modifying CTE because (a) it's a one-time migration so the
--    duplication has no runtime cost, and (b) it's the most predictable
--    pattern across PG versions / poolers.
-- ----------------------------------------------------------------------------

-- 4a. Backfill players.club_id
WITH club_mapping(source_name, canonical_name) AS (
  VALUES
    -- Direct matches (senior name is already canonical)
    ('American Fork',                     'American Fork'),
    ('Brighton',                          'Brighton'),
    ('Cache Valley',                      'Cache Valley'),
    ('Eagle Mountain',                    'Eagle Mountain'),
    ('East',                              'East'),
    ('Herriman',                          'Herriman'),
    ('Kearns',                            'Kearns'),
    ('LCA',                               'LCA'),
    ('Mountain Ridge',                    'Mountain Ridge'),
    ('Mountain Valley Powerhouse',        'Mountain Valley Powerhouse'),
    ('Mountain View',                     'Mountain View'),
    ('Orem',                              'Orem'),
    ('Pleasant Grove',                    'Pleasant Grove'),
    ('Provo Steelers',                    'Provo Steelers'),
    ('Richfield Broncos',                 'Richfield Broncos'),
    ('Salt Lake Valley Rhinos',           'Salt Lake Valley Rhinos'),
    ('Skyline',                           'Skyline'),
    ('Springville',                       'Springville'),
    ('Tooele',                            'Tooele'),
    ('Wasatch',                           'Wasatch'),
    ('West Valley Warriors',              'West Valley Warriors'),
    -- Decided merges
    ('MVP',                               'Mountain Valley Powerhouse'),
    ('Provo',                             'Provo Steelers'),
    ('Mountain Ridge Black',              'Mountain Ridge'),
    -- "Little" prefix drops, senior counterpart already in data
    ('Little Brighton',                   'Brighton'),
    ('Little Eagle Mountain',             'Eagle Mountain'),
    ('Little East',                       'East'),
    ('Little Herriman',                   'Herriman'),
    ('Little Kearns',                     'Kearns'),
    ('Little LCA',                        'LCA'),
    ('Little Mountain Ridge',             'Mountain Ridge'),
    ('Little Mountain Valley Powerhouse', 'Mountain Valley Powerhouse'),
    ('Little Mountain View',              'Mountain View'),
    ('Little Pleasant Grove',             'Pleasant Grove'),
    ('Little Provo Steelers',             'Provo Steelers'),
    ('Little Richfield',                  'Richfield Broncos'),
    ('Little Salt Lake Valley Rhinos',    'Salt Lake Valley Rhinos'),
    ('Little Skyline',                    'Skyline'),
    ('Little Springville',                'Springville'),
    ('Little Tooele',                     'Tooele'),
    ('Little Wasatch',                    'Wasatch'),
    -- "Little" prefix drops, no senior counterpart (only youth in data)
    ('Little Cavemen Rugby',              'Cavemen Rugby'),
    ('Little Highland',                   'Highland'),
    ('Little Majestics',                  'Majestics'),
    ('Little Olympus',                    'Olympus'),
    ('Little South Davis',                'South Davis'),
    ('Little United',                     'United'),
    ('Little War Frog',                   'War Frog'),
    ('Little Westlake Drua',              'Westlake Drua'),
    ('Little Westside Lions',             'Westside Lions'),
    -- Cache Valley Pirates merge (decision: roll into 'Cache Valley')
    ('Little Cache Valley Pirates',       'Cache Valley')
),
normalized_mapping AS (
  SELECT
    lower(regexp_replace(trim(source_name), '\s+', ' ', 'g')) AS source_norm,
    canonical_name
  FROM club_mapping
)
UPDATE public.players p
SET club_id = c.id
FROM normalized_mapping m
JOIN public.clubs c ON c.name = m.canonical_name
WHERE lower(regexp_replace(trim(coalesce(p.club, '')), '\s+', ' ', 'g')) = m.source_norm
  AND p.club_id IS NULL;

-- 4b. Backfill roster_players.club_id (same mapping, same logic).
WITH club_mapping(source_name, canonical_name) AS (
  VALUES
    ('American Fork',                     'American Fork'),
    ('Brighton',                          'Brighton'),
    ('Cache Valley',                      'Cache Valley'),
    ('Eagle Mountain',                    'Eagle Mountain'),
    ('East',                              'East'),
    ('Herriman',                          'Herriman'),
    ('Kearns',                            'Kearns'),
    ('LCA',                               'LCA'),
    ('Mountain Ridge',                    'Mountain Ridge'),
    ('Mountain Valley Powerhouse',        'Mountain Valley Powerhouse'),
    ('Mountain View',                     'Mountain View'),
    ('Orem',                              'Orem'),
    ('Pleasant Grove',                    'Pleasant Grove'),
    ('Provo Steelers',                    'Provo Steelers'),
    ('Richfield Broncos',                 'Richfield Broncos'),
    ('Salt Lake Valley Rhinos',           'Salt Lake Valley Rhinos'),
    ('Skyline',                           'Skyline'),
    ('Springville',                       'Springville'),
    ('Tooele',                            'Tooele'),
    ('Wasatch',                           'Wasatch'),
    ('West Valley Warriors',              'West Valley Warriors'),
    ('MVP',                               'Mountain Valley Powerhouse'),
    ('Provo',                             'Provo Steelers'),
    ('Mountain Ridge Black',              'Mountain Ridge'),
    ('Little Brighton',                   'Brighton'),
    ('Little Eagle Mountain',             'Eagle Mountain'),
    ('Little East',                       'East'),
    ('Little Herriman',                   'Herriman'),
    ('Little Kearns',                     'Kearns'),
    ('Little LCA',                        'LCA'),
    ('Little Mountain Ridge',             'Mountain Ridge'),
    ('Little Mountain Valley Powerhouse', 'Mountain Valley Powerhouse'),
    ('Little Mountain View',              'Mountain View'),
    ('Little Pleasant Grove',             'Pleasant Grove'),
    ('Little Provo Steelers',             'Provo Steelers'),
    ('Little Richfield',                  'Richfield Broncos'),
    ('Little Salt Lake Valley Rhinos',    'Salt Lake Valley Rhinos'),
    ('Little Skyline',                    'Skyline'),
    ('Little Springville',                'Springville'),
    ('Little Tooele',                     'Tooele'),
    ('Little Wasatch',                    'Wasatch'),
    ('Little Cavemen Rugby',              'Cavemen Rugby'),
    ('Little Highland',                   'Highland'),
    ('Little Majestics',                  'Majestics'),
    ('Little Olympus',                    'Olympus'),
    ('Little South Davis',                'South Davis'),
    ('Little United',                     'United'),
    ('Little War Frog',                   'War Frog'),
    ('Little Westlake Drua',              'Westlake Drua'),
    ('Little Westside Lions',             'Westside Lions'),
    ('Little Cache Valley Pirates',       'Cache Valley')
),
normalized_mapping AS (
  SELECT
    lower(regexp_replace(trim(source_name), '\s+', ' ', 'g')) AS source_norm,
    canonical_name
  FROM club_mapping
)
UPDATE public.roster_players rp
SET club_id = c.id
FROM normalized_mapping m
JOIN public.clubs c ON c.name = m.canonical_name
WHERE lower(regexp_replace(trim(coalesce(rp.club, '')), '\s+', ' ', 'g')) = m.source_norm
  AND rp.club_id IS NULL;

-- ----------------------------------------------------------------------------
-- 6. Rewrite the legacy free-text 'club' column to the canonical name, so
--    realtime payloads / fetchRoster surface clean values to clients that
--    don't know about club_id yet.
-- ----------------------------------------------------------------------------
UPDATE public.players p
SET club = c.name
FROM public.clubs c
WHERE p.club_id = c.id
  AND p.club IS DISTINCT FROM c.name;

UPDATE public.roster_players rp
SET club = c.name
FROM public.clubs c
WHERE rp.club_id = c.id
  AND rp.club IS DISTINCT FROM c.name;

-- ----------------------------------------------------------------------------
-- 7. Trigger: keep roster_players.club_id derived from .club on every write.
--    The strict picker on the client guarantees .club is always a canonical
--    club name; if a future write smuggles in an unknown name, club_id will
--    fall back to NULL (no-op rather than referential failure).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.derive_roster_players_club_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.club IS NULL OR NEW.club = '' THEN
    NEW.club_id := NULL;
  ELSE
    NEW.club_id := (
      SELECT id FROM public.clubs
      WHERE lower(name) = lower(NEW.club)
      LIMIT 1
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_roster_players_derive_club_id ON public.roster_players;
CREATE TRIGGER trg_roster_players_derive_club_id
  BEFORE INSERT OR UPDATE OF club ON public.roster_players
  FOR EACH ROW EXECUTE FUNCTION public.derive_roster_players_club_id();

-- Mirror the same trigger on players for consistency. Cheap insurance against
-- any code path (sheets sync, RPCs) that still writes to that table.
CREATE OR REPLACE FUNCTION public.derive_players_club_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.club IS NULL OR NEW.club = '' THEN
    NEW.club_id := NULL;
  ELSE
    NEW.club_id := (
      SELECT id FROM public.clubs
      WHERE lower(name) = lower(NEW.club)
      LIMIT 1
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_players_derive_club_id ON public.players;
CREATE TRIGGER trg_players_derive_club_id
  BEFORE INSERT OR UPDATE OF club ON public.players
  FOR EACH ROW EXECUTE FUNCTION public.derive_players_club_id();

-- ----------------------------------------------------------------------------
-- 8. Visibility: report any rows that still have a club name but no
--    canonical club_id. Should be zero given the mapping above.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  unmatched_players INT;
  unmatched_rosters INT;
BEGIN
  SELECT COUNT(*) INTO unmatched_players
  FROM public.players
  WHERE coalesce(club, '') <> '' AND club_id IS NULL;

  SELECT COUNT(*) INTO unmatched_rosters
  FROM public.roster_players
  WHERE coalesce(club, '') <> '' AND club_id IS NULL;

  RAISE NOTICE
    'Migration 025 backfill: % unmatched player rows, % unmatched roster_players rows',
    unmatched_players, unmatched_rosters;
END
$$;

-- ============================================================================
-- Verification queries (read-only):
--
--   SELECT name FROM public.clubs ORDER BY name;
--   -- expected: 30 rows
--
--   SELECT club, COUNT(*)
--   FROM public.roster_players
--   WHERE club_id IS NULL AND coalesce(club, '') <> ''
--   GROUP BY club;
--   -- expected: zero rows (every legacy value resolved to a canonical id)
--
--   SELECT c.name AS canonical, rp.club AS legacy_text, COUNT(*)
--   FROM public.roster_players rp
--   JOIN public.clubs c ON c.id = rp.club_id
--   GROUP BY c.name, rp.club
--   ORDER BY c.name, rp.club;
--   -- expected: legacy_text == canonical for every row (cleaned in step 6)
-- ============================================================================
