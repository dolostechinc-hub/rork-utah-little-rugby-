import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system/legacy';
import { decode as decodeBase64 } from 'base64-arraybuffer';

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

export async function uploadPlayerPhoto(
  playerId: string,
  photoUri: string,
  orgId: string
): Promise<string | null> {
  try {
    console.log('Uploading photo to cloud for player:', playerId);

    if (!supabaseUrl || !supabaseAnonKey) {
      console.error('Supabase not configured - cannot upload photo to cloud');
      return null;
    }

    if (photoUri.startsWith('http')) {
      console.log('Photo is already a cloud URL, skipping upload:', photoUri);
      return photoUri;
    }

    const fileExt = 'jpg';
    const fileName = `${orgId}/${playerId}-${Date.now()}.${fileExt}`;

    console.log('Uploading to Supabase Storage:', fileName);

    let uploadBody: ArrayBuffer | Blob;

    if (Platform.OS === 'web') {
      const response = await fetch(photoUri);
      uploadBody = await response.blob();
    } else {
      console.log('Reading photo as base64 for native upload...');
      const base64 = await FileSystem.readAsStringAsync(photoUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      if (!base64) {
        console.error('Failed to read photo file as base64');
        return null;
      }
      uploadBody = decodeBase64(base64);
      console.log('Photo read, byte length:', (uploadBody as ArrayBuffer).byteLength);
    }

    const { data, error } = await supabase.storage
      .from('player_photos')
      .upload(fileName, uploadBody, {
        contentType: 'image/jpeg',
        upsert: true,
      });

    if (error) {
      console.error('Photo upload error:', error.message);
      return null;
    }

    const { data: urlData } = supabase.storage
      .from('player_photos')
      .getPublicUrl(data.path);

    console.log('Photo uploaded to cloud successfully:', urlData.publicUrl);
    return urlData.publicUrl;
  } catch (error) {
    console.error('Failed to upload photo to cloud:', error);
    return null;
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
