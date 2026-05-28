# Add coach check-in with photos and certification badges


## What this adds

When you filter the roster or check-in screen by club, age group, division, or team name, any coaches assigned to those teams will appear in their own section — showing their photo, name, and a certification badge. You can tap a coach to check them in, just like players. All coach data (photos, certification status, check-ins) syncs to Supabase so other volunteers see updates in real time.

## How it works

### Coaches appear when you filter
- After selecting filters (e.g. Club: Brighton, Age: U14, Division: Restricted, Team: Brighton Blue), a **Coaches** section appears above the player list.
- Up to 4 coaches per team are shown with their photo, name, and a "Certified" or "Not Certified" badge.
- Coaches assigned to multiple teams show up under any team they're linked to.

### Coach check-in
- Tapping a coach card checks them in with a confirmation animation.
- Checked-in coaches get a green verified badge, just like players.
- Check-in status syncs to Supabase in real time.

### Certification tracking
- Each coach has a certification toggle visible when you tap their card.
- Admins can mark coaches as certified from the coach detail screen.
- The certification badge is visible on the check-in and roster screens.

### Data lives in Supabase
- Two new tables: `coaches` (name, photo, certified, check-in) and `coach_teams` (which teams each coach belongs to).
- Follows the same real-time sync pattern already used for the player roster.
- Coaches can be added and managed directly in Supabase, or loaded from a CSV import.

### Nothing else changes
- No existing tables, types, or player logic are modified.
- This is a purely additive feature that sits alongside the existing player check-in flow.
