-- Re-open player_photos bucket for anonymous (anon key) uploads.
--
-- Background: migration 007 locked down writes so only the service role
-- (via the signed-upload-url Edge Function) could upload. That caused
-- "Photo Upload Failed" errors in production because the app uses
-- PIN-based auth (not Supabase Auth) and uploads directly with the anon key.
--
-- For event-day stability we allow anon inserts/updates on the
-- `player_photos` bucket. Reads remain public (see migration 004).
-- The bucket path is scoped by org/player in the client, so this is the
-- same security posture as migration 005.

-- Make sure the bucket exists and is public-read.
INSERT INTO storage.buckets (id, name, public)
VALUES ('player_photos', 'player_photos', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- Drop any existing conflicting policies so this is idempotent.
DROP POLICY IF EXISTS "Anyone can upload player photos" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can update player photos" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can delete player photos" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload player photos" ON storage.objects;
DROP POLICY IF EXISTS "Users can update their org photos" ON storage.objects;
DROP POLICY IF EXISTS "Admins can delete player photos" ON storage.objects;
DROP POLICY IF EXISTS "Public read access for player photos" ON storage.objects;

-- Public reads (bucket is public, but keep the policy for clarity).
CREATE POLICY "Public read access for player photos"
ON storage.objects FOR SELECT
USING (bucket_id = 'player_photos');

-- Anon + authenticated uploads.
CREATE POLICY "Anyone can upload player photos"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'player_photos');

-- Anon + authenticated updates (supports upsert: true on reuploads).
CREATE POLICY "Anyone can update player photos"
ON storage.objects FOR UPDATE
USING (bucket_id = 'player_photos')
WITH CHECK (bucket_id = 'player_photos');

-- Anon + authenticated deletes (used by deletePlayerPhoto).
CREATE POLICY "Anyone can delete player photos"
ON storage.objects FOR DELETE
USING (bucket_id = 'player_photos');
