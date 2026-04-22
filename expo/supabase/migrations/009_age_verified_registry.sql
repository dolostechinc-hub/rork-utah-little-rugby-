-- Age Verified Registry
--
-- Persists a list of players who have had their age verified (birth certificate,
-- passport, etc.) so that in future seasons they do NOT need to bring
-- verification documents again. They just show up, get weighed and
-- photographed, and we auto-check the "Age Verified" box because they exist
-- in this registry.
--
-- Keyed by (org_id, normalized name + date of birth). org_id is stored as TEXT
-- because the app sometimes uses string slugs (e.g. "utah-little-rugby") in
-- addition to UUIDs.

CREATE TABLE IF NOT EXISTS age_verified_registry (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id TEXT NOT NULL,
  normalized_key TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  date_of_birth TEXT NOT NULL,
  verified_at TIMESTAMPTZ DEFAULT NOW(),
  verified_by TEXT,
  notes TEXT,
  UNIQUE(org_id, normalized_key)
);

CREATE INDEX IF NOT EXISTS idx_age_verified_registry_org_id
  ON age_verified_registry(org_id);

CREATE INDEX IF NOT EXISTS idx_age_verified_registry_key
  ON age_verified_registry(org_id, normalized_key);

ALTER TABLE age_verified_registry ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read age verified registry" ON age_verified_registry;
DROP POLICY IF EXISTS "Anyone can insert age verified registry" ON age_verified_registry;
DROP POLICY IF EXISTS "Anyone can update age verified registry" ON age_verified_registry;
DROP POLICY IF EXISTS "Anyone can delete age verified registry" ON age_verified_registry;

CREATE POLICY "Anyone can read age verified registry"
ON age_verified_registry FOR SELECT USING (true);

CREATE POLICY "Anyone can insert age verified registry"
ON age_verified_registry FOR INSERT WITH CHECK (true);

CREATE POLICY "Anyone can update age verified registry"
ON age_verified_registry FOR UPDATE USING (true) WITH CHECK (true);

CREATE POLICY "Anyone can delete age verified registry"
ON age_verified_registry FOR DELETE USING (true);
