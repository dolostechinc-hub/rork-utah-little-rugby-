import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { File, Directory, Paths } from 'expo-file-system';

const supabaseUrl =
  process.env.EXPO_PUBLIC_SUPABASE_URL ??
  Constants.expoConfig?.extra?.EXPO_PUBLIC_SUPABASE_URL;

const supabaseAnonKey =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
  Constants.expoConfig?.extra?.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    'Missing Supabase env vars. Supabase features will be unavailable. Ensure EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY are set.'
  );
}

export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'placeholder-key',
  {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: Platform.OS === 'web',
    },
  }
);

async function savePhotoLocally(playerId: string, photoUri: string): Promise<string | null> {
  try {
    if (Platform.OS === 'web') {
      console.log('Web platform - returning original URI');
      return photoUri;
    }

    const photoDir = new Directory(Paths.document, 'player_photos');

    if (!photoDir.exists) {
      console.log('Creating player_photos directory...');
      photoDir.create();
    }

    const fileName = `${playerId}-${Date.now()}.jpg`;
    const sourceFile = new File(photoUri);
    const destFile = new File(photoDir, fileName);

    console.log('Copying photo to persistent storage:', destFile.uri);
    sourceFile.copy(destFile);

    console.log('Photo saved locally:', destFile.uri);
    return destFile.uri;
  } catch (error) {
    console.error('Failed to save photo locally:', error);
    return photoUri;
  }
}

export async function uploadPlayerPhoto(
  playerId: string,
  photoUri: string,
  orgId: string
): Promise<string | null> {
  try {
    console.log('Uploading photo for player:', playerId);
    
    // Check if Supabase is properly configured
    if (!supabaseUrl || !supabaseAnonKey) {
      console.warn('Supabase not configured - saving photo locally');
      return savePhotoLocally(playerId, photoUri);
    }
    
    const response = await fetch(photoUri);
    const blob = await response.blob();
    
    const fileExt = 'jpg';
    const fileName = `${orgId}/${playerId}-${Date.now()}.${fileExt}`;
    
    const { data, error } = await supabase.storage
      .from('player_photos')
      .upload(fileName, blob, {
        contentType: 'image/jpeg',
        upsert: true,
      });

    if (error) {
      // Handle bucket not found error gracefully
      if (error.message?.includes('Bucket not found') || error.message?.includes('bucket')) {
        console.warn('Storage bucket not configured - saving photo locally');
        return savePhotoLocally(playerId, photoUri);
      }
      console.error('Photo upload error:', error.message);
      return savePhotoLocally(playerId, photoUri);
    }

    const { data: urlData } = supabase.storage
      .from('player_photos')
      .getPublicUrl(data.path);

    console.log('Photo uploaded successfully:', urlData.publicUrl);
    return urlData.publicUrl;
  } catch (error) {
    console.error('Failed to upload photo:', error);
    return savePhotoLocally(playerId, photoUri);
  }
}

export async function deletePlayerPhoto(photoUrl: string): Promise<boolean> {
  try {
    const path = photoUrl.split('/player_photos/')[1];
    if (!path) return false;

    const { error } = await supabase.storage
      .from('player_photos')
      .remove([path]);

    if (error) {
      console.error('Photo delete error:', error);
      return false;
    }

    console.log('Photo deleted successfully');
    return true;
  } catch (error) {
    console.error('Failed to delete photo:', error);
    return false;
  }
}
