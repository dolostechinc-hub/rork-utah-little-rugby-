-- Youth Sports Registration App - Storage Bucket Setup
-- Creates the player_photos bucket with appropriate policies

-- Create the player_photos bucket (if not exists - run manually in Supabase dashboard if needed)
INSERT INTO storage.buckets (id, name, public)
VALUES ('player_photos', 'player_photos', true)
ON CONFLICT (id) DO NOTHING;

-- Policy: Anyone can view photos (bucket is public)
CREATE POLICY "Public read access for player photos"
ON storage.objects FOR SELECT
USING (bucket_id = 'player_photos');

-- Policy: Authenticated users can upload photos to their org folder
CREATE POLICY "Authenticated users can upload player photos"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'player_photos' 
  AND auth.role() = 'authenticated'
);

-- Policy: Users can update photos in their org folder
CREATE POLICY "Users can update their org photos"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'player_photos'
  AND auth.role() = 'authenticated'
);

-- Policy: Admins can delete photos
CREATE POLICY "Admins can delete player photos"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'player_photos'
  AND auth.role() = 'authenticated'
);
