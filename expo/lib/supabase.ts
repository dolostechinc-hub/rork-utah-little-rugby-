import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system/legacy';
import { decode as decodeBase64 } from 'base64-arraybuffer';
import { getEditorSession } from '@/lib/editorSession';

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

interface PhotoBodyResult {
  body: ArrayBuffer | Blob;
  size: number;
  source: 'base64' | 'blob';
}

async function readPhotoAsBody(photoUri: string): Promise<PhotoBodyResult> {
  if (Platform.OS === 'web') {
    const response = await fetch(photoUri);
    const blob = await response.blob();
    return { body: blob, size: blob.size, source: 'blob' };
  }

  let base64Err: unknown = null;
  try {
    console.log('Reading photo as base64 for native upload...');
    const base64 = await FileSystem.readAsStringAsync(photoUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    if (base64) {
      const ab = decodeBase64(base64);
      console.log('Photo read via base64, byte length:', ab.byteLength);
      return { body: ab, size: ab.byteLength, source: 'base64' };
    }
    base64Err = new Error('empty base64 string from FileSystem');
  } catch (err) {
    base64Err = err;
    console.warn('base64 read failed, falling back to fetch().blob():', err);
  }

  try {
    const response = await fetch(photoUri);
    const blob = await response.blob();
    console.log('Photo read via fetch, size:', (blob as Blob).size);
    return { body: blob, size: (blob as Blob).size, source: 'blob' };
  } catch (err) {
    console.error('fetch().blob() also failed:', err);
    const b64Msg = base64Err instanceof Error ? base64Err.message : String(base64Err);
    const fetchMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not read photo file. base64: ${b64Msg}; fetch: ${fetchMsg}`);
  }
}

interface SignedUpload {
  path: string;
  token: string;
  signedUrl: string;
  publicUrl: string;
}

async function requestSignedUpload(
  orgId: string,
  playerId: string,
  ext: string = 'jpg',
): Promise<SignedUpload | null> {
  const session = getEditorSession();
  const {
    data: { session: authSession },
  } = await supabase.auth.getSession();

  if (!session?.token && !authSession) {
    console.error('No editor session or admin auth; cannot upload.');
    return null;
  }

  const url = `${supabaseUrl}/functions/v1/signed-upload-url`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    apikey: supabaseAnonKey ?? '',
    Authorization: `Bearer ${authSession?.access_token ?? supabaseAnonKey ?? ''}`,
  };
  if (session?.token) headers['x-editor-session'] = session.token;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ orgId, playerId, ext, sessionToken: session?.token }),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.warn('signed-upload-url failed:', res.status, txt);
      return null;
    }
    return (await res.json()) as SignedUpload;
  } catch (err) {
    console.error('signed-upload-url request error:', err);
    return null;
  }
}

export const PLAYER_PHOTOS_BUCKET = 'player_photos';

export async function uploadPlayerPhoto(
  playerId: string,
  photoUri: string,
  orgId: string,
  maxRetries: number = 3
): Promise<string> {
  console.log('[uploadPlayerPhoto] start', {
    playerId,
    orgId,
    photoUri,
    supabaseUrl,
    bucket: PLAYER_PHOTOS_BUCKET,
    platform: Platform.OS,
  });

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Supabase not configured (missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY at runtime).');
  }

  if (photoUri.startsWith('http')) {
    console.log('[uploadPlayerPhoto] photo is already a cloud URL, skipping upload:', photoUri);
    return photoUri;
  }

  const photo = await readPhotoAsBody(photoUri);
  const mimeType = 'image/jpeg';
  console.log('[uploadPlayerPhoto] body ready', {
    source: photo.source,
    size: photo.size,
    mimeType,
  });

  let lastErrorMessage = 'unknown error';
  let lastErrorObj: unknown = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[uploadPlayerPhoto] attempt ${attempt}/${maxRetries}`);

    const signed = await requestSignedUpload(orgId, playerId, 'jpg');
    if (!signed) {
      lastErrorMessage = 'Could not obtain signed upload URL (editor permission required or edge function failed)';
      console.warn('[uploadPlayerPhoto]', lastErrorMessage);
      if (attempt < maxRetries) {
        await new Promise((res) => setTimeout(res, 800 * attempt));
      }
      continue;
    }

    console.log('[uploadPlayerPhoto] signed upload info', {
      path: signed.path,
      publicUrl: signed.publicUrl,
      upsert: true,
    });

    const { data, error } = await supabase.storage
      .from(PLAYER_PHOTOS_BUCKET)
      .uploadToSignedUrl(signed.path, signed.token, photo.body, {
        contentType: mimeType,
        upsert: true,
      });

    if (!error && data) {
      console.log('[uploadPlayerPhoto] SUCCESS', { publicUrl: signed.publicUrl, path: signed.path });
      return signed.publicUrl;
    }

    lastErrorObj = error;
    lastErrorMessage = error?.message || 'unknown error';
    console.warn(`[uploadPlayerPhoto] attempt ${attempt} failed`, {
      message: lastErrorMessage,
      error,
      path: signed.path,
      size: photo.size,
      source: photo.source,
    });

    if (attempt < maxRetries) {
      await new Promise((res) => setTimeout(res, 800 * attempt));
    }
  }

  console.error('[uploadPlayerPhoto] failed after all retries', {
    message: lastErrorMessage,
    error: lastErrorObj,
    supabaseUrl,
    bucket: PLAYER_PHOTOS_BUCKET,
  });
  throw new Error(lastErrorMessage);
}

export async function debugUploadTest(orgId: string = 'debug'): Promise<{
  success: boolean;
  url?: string;
  supabaseUrl: string | undefined;
  bucket: string;
  path: string;
  size: number;
  error?: string;
  errorObj?: unknown;
}> {
  const bucket = PLAYER_PHOTOS_BUCKET;
  const testId = `debug-${Date.now()}`;
  const path = `${orgId}/${testId}.txt`;
  const bodyText = `debug upload test at ${new Date().toISOString()}`;
  const bodyBytes = new TextEncoder().encode(bodyText);

  console.log('[debugUploadTest] start', { supabaseUrl, bucket, path, size: bodyBytes.byteLength });

  try {
    const { data, error } = await supabase.storage.from(bucket).upload(path, bodyBytes, {
      contentType: 'text/plain',
      upsert: true,
    });

    if (error || !data) {
      console.error('[debugUploadTest] failed', { error });
      return {
        success: false,
        supabaseUrl,
        bucket,
        path,
        size: bodyBytes.byteLength,
        error: error?.message ?? 'unknown error',
        errorObj: error,
      };
    }

    const { data: pub } = supabase.storage.from(bucket).getPublicUrl(data.path);
    console.log('[debugUploadTest] SUCCESS', { path: data.path, url: pub.publicUrl });
    return {
      success: true,
      url: pub.publicUrl,
      supabaseUrl,
      bucket,
      path: data.path,
      size: bodyBytes.byteLength,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[debugUploadTest] exception', err);
    return {
      success: false,
      supabaseUrl,
      bucket,
      path,
      size: bodyBytes.byteLength,
      error: message,
      errorObj: err,
    };
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
