-- Lock down the player_photos bucket.
-- Keep public reads (player photos need to be visible on all devices),
-- but remove anonymous write/update/delete policies.
-- All writes now flow through the `signed-upload-url` Edge Function,
-- which uses the service role key after validating an editor session token.

DROP POLICY IF EXISTS "Anyone can upload player photos" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can update player photos" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can delete player photos" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload player photos" ON storage.objects;
DROP POLICY IF EXISTS "Users can update their org photos" ON storage.objects;
DROP POLICY IF EXISTS "Admins can delete player photos" ON storage.objects;

-- The bucket stays public for reads (policy "Public read access for player photos"
-- from migration 004 is preserved). No anon writes are permitted.
-- Service role (used by Edge Functions) bypasses RLS entirely.

-- Ensure bucket exists and is public-read only.
UPDATE storage.buckets SET public = true WHERE id = 'player_photos';
