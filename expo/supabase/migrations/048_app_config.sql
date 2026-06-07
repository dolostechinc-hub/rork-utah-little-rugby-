-- ============================================================================
-- Migration 048: App configuration table for force-update & feature flags
-- ============================================================================
-- A single-row-per-key config table so the app can check for a minimum
-- required version, store deep-link URLs, and toggle feature flags without
-- shipping a new native build.
--
-- The app fetches the row where key = 'min_version' on every cold start (and
-- periodically in the background). If the running version is older, it shows
-- a full-screen "Update Required" prompt with a link to the App Store / Play
-- Store. The row also carries platform-specific store URLs so the prompt
-- opens the correct store.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.app_config (
  key          TEXT PRIMARY KEY,
  value        TEXT NOT NULL,
  description  TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable realtime so config changes propagate without a restart
ALTER TABLE public.app_config ENABLE REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.app_config;

-- ── Seed row: set to current prod version so no one gets force-blocked ──
INSERT INTO public.app_config (key, value, description)
VALUES (
  'min_version',
  '3.2.2',
  'Minimum required app version. Bump this to force users to update. Format: semver (e.g. 3.2.3).'
)
ON CONFLICT (key) DO NOTHING;

-- Store URLs for the update prompt so the app opens the correct store page.
INSERT INTO public.app_config (key, value, description)
VALUES (
  'app_store_url',
  'https://apps.apple.com/us/app/utah-little-rugby/id6759469923',
  'App Store URL for iOS update prompt.'
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.app_config (key, value, description)
VALUES (
  'play_store_url',
  'https://play.google.com/store/apps/details?id=app.rork.utah.little.rugby.app',
  'Google Play URL for Android update prompt.'
)
ON CONFLICT (key) DO NOTHING;

COMMIT;
