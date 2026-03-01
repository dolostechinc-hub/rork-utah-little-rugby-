-- Youth Sports Registration App - Row Level Security Policies
-- This migration enables RLS and creates policies for multi-tenant isolation

-- Enable RLS on all tables
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_check_ins ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_privacy_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_passes ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_views ENABLE ROW LEVEL SECURITY;

-- Helper function to check if user is a member of an organization
CREATE OR REPLACE FUNCTION is_org_member(org_uuid UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM org_members 
    WHERE org_id = org_uuid AND user_id = auth.uid()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Helper function to check if user has admin role in an organization
CREATE OR REPLACE FUNCTION is_org_admin(org_uuid UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM org_members 
    WHERE org_id = org_uuid 
    AND user_id = auth.uid()
    AND role IN ('owner', 'admin')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Helper function to get user's organizations
CREATE OR REPLACE FUNCTION get_user_org_ids()
RETURNS SETOF UUID AS $$
BEGIN
  RETURN QUERY SELECT org_id FROM org_members WHERE user_id = auth.uid();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Organizations policies
CREATE POLICY "Users can view orgs they belong to"
  ON organizations FOR SELECT
  USING (id IN (SELECT get_user_org_ids()));

-- Allow anyone to look up organizations by code (for joining)
CREATE POLICY "Anyone can look up orgs by code"
  ON organizations FOR SELECT
  USING (true);

CREATE POLICY "Users can create organizations"
  ON organizations FOR INSERT
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "Admins can update their organizations"
  ON organizations FOR UPDATE
  USING (is_org_admin(id));

CREATE POLICY "Owners can delete their organizations"
  ON organizations FOR DELETE
  USING (owner_id = auth.uid());

-- Org members policies
CREATE POLICY "Members can view org members of their orgs"
  ON org_members FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins can insert org members"
  ON org_members FOR INSERT
  WITH CHECK (is_org_admin(org_id) OR user_id = auth.uid());

CREATE POLICY "Admins can update org members"
  ON org_members FOR UPDATE
  USING (is_org_admin(org_id));

CREATE POLICY "Admins can delete org members"
  ON org_members FOR DELETE
  USING (is_org_admin(org_id) OR user_id = auth.uid());

-- Teams policies
CREATE POLICY "Members can view teams in their orgs"
  ON teams FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins can insert teams"
  ON teams FOR INSERT
  WITH CHECK (is_org_admin(org_id));

CREATE POLICY "Admins can update teams"
  ON teams FOR UPDATE
  USING (is_org_admin(org_id));

CREATE POLICY "Admins can delete teams"
  ON teams FOR DELETE
  USING (is_org_admin(org_id));

-- Players policies
CREATE POLICY "Members can view players in their orgs"
  ON players FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins can insert players"
  ON players FOR INSERT
  WITH CHECK (is_org_admin(org_id));

CREATE POLICY "Admins can update players"
  ON players FOR UPDATE
  USING (is_org_admin(org_id));

CREATE POLICY "Admins can delete players"
  ON players FOR DELETE
  USING (is_org_admin(org_id));

-- Events policies
CREATE POLICY "Members can view events in their orgs"
  ON events FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins can insert events"
  ON events FOR INSERT
  WITH CHECK (is_org_admin(org_id));

CREATE POLICY "Admins can update events"
  ON events FOR UPDATE
  USING (is_org_admin(org_id));

CREATE POLICY "Admins can delete events"
  ON events FOR DELETE
  USING (is_org_admin(org_id));

-- Event teams policies
CREATE POLICY "Members can view event teams for their events"
  ON event_teams FOR SELECT
  USING (
    event_id IN (
      SELECT e.id FROM events e WHERE e.org_id IN (SELECT get_user_org_ids())
    )
  );

CREATE POLICY "Admins can manage event teams"
  ON event_teams FOR ALL
  USING (
    event_id IN (
      SELECT e.id FROM events e WHERE is_org_admin(e.org_id)
    )
  );

-- Event check-ins policies
CREATE POLICY "Members can view check-ins for their events"
  ON event_check_ins FOR SELECT
  USING (
    event_id IN (
      SELECT e.id FROM events e WHERE e.org_id IN (SELECT get_user_org_ids())
    )
  );

CREATE POLICY "Members can insert check-ins"
  ON event_check_ins FOR INSERT
  WITH CHECK (
    event_id IN (
      SELECT e.id FROM events e WHERE e.org_id IN (SELECT get_user_org_ids())
    )
  );

CREATE POLICY "Admins can update check-ins"
  ON event_check_ins FOR UPDATE
  USING (
    event_id IN (
      SELECT e.id FROM events e WHERE is_org_admin(e.org_id)
    )
  );

-- Privacy settings policies
CREATE POLICY "Members can view privacy settings for their orgs"
  ON org_privacy_settings FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins can manage privacy settings"
  ON org_privacy_settings FOR ALL
  USING (is_org_admin(org_id));

-- Verification passes policies
CREATE POLICY "Members can view passes for their orgs"
  ON verification_passes FOR SELECT
  USING (issuing_org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Members can create passes"
  ON verification_passes FOR INSERT
  WITH CHECK (issuing_org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins can manage passes"
  ON verification_passes FOR UPDATE
  USING (is_org_admin(issuing_org_id));

-- Verification views policies (audit log - read-only for members)
CREATE POLICY "Members can view verification logs for their orgs"
  ON verification_views FOR SELECT
  USING (
    event_id IN (
      SELECT e.id FROM events e WHERE e.org_id IN (SELECT get_user_org_ids())
    )
  );

CREATE POLICY "System can insert verification views"
  ON verification_views FOR INSERT
  WITH CHECK (true);
