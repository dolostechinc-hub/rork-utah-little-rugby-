-- Allow anonymous uploads to player_photos bucket
-- This is needed because the app uses PIN-based auth, not Supabase Auth
-- Photos are uploaded from multiple devices and must be stored in the cloud

-- Drop the old authenticated-only upload policy
DROP POLICY IF EXISTS "Authenticated users can upload player photos" ON storage.objects;
DROP POLICY IF EXISTS "Users can update their org photos" ON storage.objects;
DROP POLICY IF EXISTS "Admins can delete player photos" ON storage.objects;

-- Allow anyone to upload photos (bucket is already public for reads)
CREATE POLICY "Anyone can upload player photos"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'player_photos');

-- Allow anyone to update photos
CREATE POLICY "Anyone can update player photos"
ON storage.objects FOR UPDATE
USING (bucket_id = 'player_photos');

-- Allow anyone to delete photos
CREATE POLICY "Anyone can delete player photos"
ON storage.objects FOR DELETE
USING (bucket_id = 'player_photos');
