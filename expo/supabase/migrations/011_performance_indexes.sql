-- Performance indexes for high-concurrency check-in day.
-- Safe to run multiple times (all IF NOT EXISTS). Zero downtime.
-- Run in Supabase SQL Editor.

-- ============================================================
-- roster_players: the hot table during check-in
-- ============================================================
-- Already has: idx_roster_players_org_id, idx_roster_players_updated_at

-- Compound index for the common "roster for this org, most recent first"
-- query. Also accelerates realtime replication filtering.
CREATE INDEX IF NOT EXISTS idx_roster_players_org_updated
  ON public.roster_players(org_id, updated_at DESC);

-- Fast lookups when syncing a single player by id within an org.
CREATE INDEX IF NOT EXISTS idx_roster_players_org_id_id
  ON public.roster_players(org_id, id);

-- ============================================================
-- age_verified_registry: hit on every check-in lookup
-- ============================================================
-- Already has: idx_age_verified_registry_org_id,
--              idx_age_verified_registry_key (org_id, normalized_key)
-- No additional indexes needed.

-- ============================================================
-- organizations / org_members: hit on login + org switching
-- ============================================================
-- organizations.code is already UNIQUE (implicit index).
-- org_members already has idx_org_members_org_id and idx_org_members_user_id.

-- Compound index for "is this user a member of this org?" checks that
-- run on every protected query / RLS policy.
CREATE INDEX IF NOT EXISTS idx_org_members_user_org
  ON org_members(user_id, org_id);

-- ============================================================
-- event_check_ins: historical check-in records
-- ============================================================
-- Already has idx_event_check_ins_event_id. Add player lookup.
CREATE INDEX IF NOT EXISTS idx_event_check_ins_player_id
  ON event_check_ins(player_id);

CREATE INDEX IF NOT EXISTS idx_event_check_ins_event_player
  ON event_check_ins(event_id, player_id);

-- ============================================================
-- verification_passes: live verification lookups
-- ============================================================
-- Already has idx_verification_passes_code + idx_verification_passes_event_id.
-- Add a partial index for the "active, non-revoked" hot path.
CREATE INDEX IF NOT EXISTS idx_verification_passes_active
  ON verification_passes(code)
  WHERE is_revoked = FALSE;

-- ============================================================
-- Refresh planner stats so the new indexes get picked up immediately.
-- ============================================================
ANALYZE public.roster_players;
ANALYZE public.age_verified_registry;
ANALYZE public.organizations;
ANALYZE public.org_members;
ANALYZE public.players;
ANALYZE public.teams;
ANALYZE public.events;
ANALYZE public.event_check_ins;
ANALYZE public.verification_passes;
