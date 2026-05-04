-- 027_remove_block_blank_roster_inserts_trigger.sql
--
-- Removes `block_blank_roster_inserts_trigger` and its backing function,
-- and replaces them with an explicit CHECK constraint on the identity
-- fields so that future bad inserts raise loudly instead of being
-- silently dropped.
--
-- BACKGROUND:
--   `block_blank_roster_inserts_trigger` was a BEFORE INSERT trigger on
--   public.roster_players that returned NULL for any incoming row where
--       checked_in = false
--       AND trim(weight)    = ''
--       AND trim(photo_uri) = ''
--   This was originally meant to keep volunteers' empty placeholder
--   rows out of the table. In practice it has been silently dropping
--   every legitimate "registered, not yet weighed/checked-in" insert
--   for months -- the most common shape of a roster row. Symptoms:
--     * Players registered on one device sometimes never appear on
--       other devices (the cloud insert was silently rejected).
--     * Bulk imports from spreadsheets / restore migrations would
--       lose 70-80% of rows for the same reason; migration 026 had
--       to disable the trigger to restore 1,666 of 2,168 Spring 2026
--       players (502 of 2,168 inserts succeeded with the trigger on).
--
-- WHY IT'S SAFE TO DROP:
--   * RegistrationContext.mergeRemoteRoster has been hardened to
--     stop deleting cloud rows or re-upserting canonical rows during
--     dedupe, which removes the "polluted empty rows during sync"
--     scenario the trigger was originally guarding against.
--   * Migration 019 already enforces `org_id IS NOT NULL AND
--     length(trim(org_id)) > 0` via roster_players_org_id_not_blank,
--     so blank-org garbage rows can't be inserted.
--   * The new CHECK constraint below requires at least one of
--     (first_name, last_name, date_of_birth) to be non-blank, which
--     covers the "absolutely empty placeholder" case the trigger was
--     trying to block.
--   * Critically: a CHECK violation raises an error, which is visible
--     to the application's cloud-sync queue and surfaces as a real
--     failure. The trigger silently dropped rows with no signal to
--     the client at all -- the worst possible failure mode for
--     a sync system.
--
-- ROLLOUT NOTES:
--   * Apply this only AFTER 026_restore_ulr_spring_2026_from_recov.sql
--     has been verified in the app. 026 disables the trigger for the
--     duration of the restore but leaves it on the table afterwards.
--   * The CHECK is added with NOT VALID first so existing rows are
--     not re-scanned; we then VALIDATE separately. If validation
--     fails it tells us a real garbage row already exists in the
--     table and we want to see that loudly, not silently re-block it.

-- 1) Drop the trigger and the function it wraps.
DROP TRIGGER IF EXISTS block_blank_roster_inserts_trigger
  ON public.roster_players;

DROP FUNCTION IF EXISTS public.block_blank_roster_inserts();

-- 2) Add an identity-not-blank CHECK so genuinely empty rows still
--    can't be inserted, but failures raise visibly to the caller.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'roster_players_identity_not_blank'
  ) THEN
    ALTER TABLE public.roster_players
      ADD CONSTRAINT roster_players_identity_not_blank
      CHECK (
        (first_name    IS NOT NULL AND length(trim(first_name))    > 0)
        OR (last_name     IS NOT NULL AND length(trim(last_name))     > 0)
        OR (date_of_birth IS NOT NULL AND length(trim(date_of_birth)) > 0)
      ) NOT VALID;
  END IF;
END
$$;

-- 3) Validate the constraint against existing rows in a separate step.
--    If this raises, it means a truly empty row already exists and we
--    want to see it -- do NOT bypass; investigate and clean up the row,
--    then re-run.
ALTER TABLE public.roster_players
  VALIDATE CONSTRAINT roster_players_identity_not_blank;

-- 4) Document the new contract on the table.
COMMENT ON CONSTRAINT roster_players_identity_not_blank
  ON public.roster_players IS
    'At least one of (first_name, last_name, date_of_birth) must be '
    'non-blank. Replaces the legacy block_blank_roster_inserts trigger '
    'which silently dropped any insert lacking checked_in/weight/photo. '
    'See migration 027.';
