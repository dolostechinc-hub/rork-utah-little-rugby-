import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { decode as decodeBase64 } from 'base64-arraybuffer';

const PHOTO_MAX_DIMENSION = 1400;
const PHOTO_COMPRESSION = 0.75;
const PHOTO_MAX_BYTES = 2 * 1024 * 1024;

async function getFileSize(uri: string): Promise<number | null> {
  if (Platform.OS === 'web') return null;

  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists && typeof info.size === 'number') {
      return info.size;
    }
  } catch (err) {
    console.warn('[compressPhoto] getInfoAsync failed:', err);
  }

  return null;
}

export async function compressPhotoForUpload(photoUri: string): Promise<string> {
  if (photoUri.startsWith('http')) return photoUri;

  try {
    console.log('[compressPhoto] start', { photoUri });

    let result = await ImageManipulator.manipulateAsync(
      photoUri,
      [{ resize: { width: PHOTO_MAX_DIMENSION } }],
      {
        compress: PHOTO_COMPRESSION,
        format: ImageManipulator.SaveFormat.JPEG,
      }
    );

    console.log('[compressPhoto] first pass', {
      uri: result.uri,
      width: result.width,
      height: result.height,
    });

    let size = await getFileSize(result.uri);
    console.log('[compressPhoto] first pass size', size);

    let compress = PHOTO_COMPRESSION;
    let dimension = PHOTO_MAX_DIMENSION;
    let pass = 0;

    while (size !== null && size > PHOTO_MAX_BYTES && pass < 3) {
      pass += 1;
      compress = Math.max(0.4, compress - 0.15);
      dimension = Math.max(800, Math.round(dimension * 0.85));

      console.log('[compressPhoto] recompressing', {
        pass,
        compress,
        dimension,
        prevSize: size,
      });

      result = await ImageManipulator.manipulateAsync(
        result.uri,
        [{ resize: { width: dimension } }],
        {
          compress,
          format: ImageManipulator.SaveFormat.JPEG,
        }
      );

      size = await getFileSize(result.uri);
      console.log('[compressPhoto] pass size', { pass, size });
    }

    return result.uri;
  } catch (err) {
    console.warn('[compressPhoto] failed, using original:', err);
    return photoUri;
  }
}

const FALLBACK_SUPABASE_URL = 'https://pfhkypuavngiidyrrnpn.supabase.co';
const FALLBACK_SUPABASE_ANON_KEY = 'sb_publishable_o6d-VXD_hzD1AYntd2_guw_dj-8ZyYX';

const supabaseUrl =
  process.env.EXPO_PUBLIC_SUPABASE_URL ??
  (Constants.expoConfig?.extra?.EXPO_PUBLIC_SUPABASE_URL as string | undefined) ??
  FALLBACK_SUPABASE_URL;

const supabaseAnonKey =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
  (Constants.expoConfig?.extra?.EXPO_PUBLIC_SUPABASE_ANON_KEY as string | undefined) ??
  FALLBACK_SUPABASE_ANON_KEY;

console.log('[supabase] init', {
  hasUrl: !!supabaseUrl,
  hasKey: !!supabaseAnonKey,
  urlSource: process.env.EXPO_PUBLIC_SUPABASE_URL
    ? 'process.env'
    : Constants.expoConfig?.extra?.EXPO_PUBLIC_SUPABASE_URL
    ? 'expo-constants'
    : 'fallback',
});

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
    console.log('[readPhotoAsBody] reading photo as base64 for native upload...');
    const base64 = await FileSystem.readAsStringAsync(photoUri, {
      encoding: FileSystem.EncodingType.Base64,
    });

    if (base64) {
      const ab = decodeBase64(base64);
      console.log('[readPhotoAsBody] photo read via base64, byte length:', ab.byteLength);
      return { body: ab, size: ab.byteLength, source: 'base64' };
    }

    base64Err = new Error('empty base64 string from FileSystem');
  } catch (err) {
    base64Err = err;
    console.warn('[readPhotoAsBody] base64 read failed, falling back to fetch().blob():', err);
  }

  try {
    const response = await fetch(photoUri);
    const blob = await response.blob();
    console.log('[readPhotoAsBody] photo read via fetch, size:', blob.size);
    return { body: blob, size: blob.size, source: 'blob' };
  } catch (err) {
    console.error('[readPhotoAsBody] fetch().blob() also failed:', err);
    const b64Msg = base64Err instanceof Error ? base64Err.message : String(base64Err);
    const fetchMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not read photo file. base64: ${b64Msg}; fetch: ${fetchMsg}`);
  }
}

export const PLAYER_PHOTOS_BUCKET = 'player_photos';
export const COACH_PHOTOS_BUCKET = 'player_photos'; // coaches share the same bucket, differentiated by path prefix

function getUploadContentType(photoUri: string): string {
  const fileExt = photoUri.split('.').pop()?.toLowerCase() || 'jpg';

  switch (fileExt) {
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'heic':
    case 'heif':
    case 'jpg':
    case 'jpeg':
    default:
      return 'image/jpeg';
  }
}

function getUploadExtension(photoUri: string): string {
  const fileExt = photoUri.split('.').pop()?.toLowerCase() || 'jpg';

  if (fileExt === 'heic' || fileExt === 'heif') {
    return 'jpg';
  }

  if (fileExt === 'jpeg') {
    return 'jpg';
  }

  return fileExt;
}

function slugifyPlayerName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 60);
}

export async function uploadPlayerPhoto(
  playerId: string,
  photoUri: string,
  orgId: string,
  maxRetries: number = 3,
  playerName?: string
): Promise<string> {
  if (!photoUri) {
    throw new Error('No photo URI provided');
  }

  if (photoUri.startsWith('http')) {
    return photoUri;
  }

  const processedUri = await compressPhotoForUpload(photoUri);
  const photo = await readPhotoAsBody(processedUri);
  const contentType = getUploadContentType(processedUri);
  const ext = getUploadExtension(processedUri);
  const nameSlug = playerName ? slugifyPlayerName(playerName) : '';
  const fileName = nameSlug
    ? `${nameSlug}_${Date.now()}.${ext}`
    : `${Date.now()}.${ext}`;
  const path = `${orgId}/${playerId}/${fileName}`;
  console.log('[uploadPlayerPhoto] path', { path, playerName, nameSlug });

  let lastError: string | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { data, error } = await supabase.storage
        .from(PLAYER_PHOTOS_BUCKET)
        .upload(path, photo.body, {
          contentType,
          upsert: true,
        });

      if (error || !data) {
        lastError = [
          'UPLOAD FAILED',
          `message: ${error?.message ?? 'unknown error'}`,
          `bucket: ${PLAYER_PHOTOS_BUCKET}`,
          `path: ${path}`,
          `contentType: ${contentType}`,
          `size: ${photo.size}`,
          `source: ${photo.source}`,
          `platform: ${Platform.OS}`,
          `attempt: ${attempt}/${maxRetries}`,
        ].join('\n');

        if (attempt < maxRetries) {
          await new Promise((res) => setTimeout(res, 800 * attempt));
          continue;
        }

        throw new Error(lastError);
      }

      const { data: pub } = supabase.storage
        .from(PLAYER_PHOTOS_BUCKET)
        .getPublicUrl(data.path);

      if (!pub?.publicUrl) {
        throw new Error(
          [
            'UPLOAD SUCCEEDED BUT URL FAILED',
            `bucket: ${PLAYER_PHOTOS_BUCKET}`,
            `path: ${data.path}`,
            `attempt: ${attempt}/${maxRetries}`,
          ].join('\n')
        );
      }

      return pub.publicUrl;
    } catch (err) {
      lastError =
        err instanceof Error
          ? err.message
          : [
              'UPLOAD FAILED',
              `message: ${String(err)}`,
              `bucket: ${PLAYER_PHOTOS_BUCKET}`,
              `path: ${path}`,
              `contentType: ${contentType}`,
              `size: ${photo.size}`,
              `source: ${photo.source}`,
              `platform: ${Platform.OS}`,
              `attempt: ${attempt}/${maxRetries}`,
            ].join('\n');

      if (attempt < maxRetries) {
        await new Promise((res) => setTimeout(res, 800 * attempt));
        continue;
      }

      throw new Error(lastError);
    }
  }

  throw new Error(lastError ?? 'UPLOAD FAILED\nmessage: unknown error');
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

  console.log('[debugUploadTest] start', {
    supabaseUrl,
    bucket,
    path,
    size: bodyBytes.byteLength,
  });

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

    console.log('[debugUploadTest] SUCCESS', {
      path: data.path,
      url: pub.publicUrl,
    });

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

export async function uploadCoachPhoto(
  coachId: string,
  photoUri: string,
  orgId: string,
  maxRetries: number = 3,
  coachName?: string
): Promise<string> {
  if (!photoUri) {
    throw new Error('No photo URI provided');
  }

  if (photoUri.startsWith('http')) {
    return photoUri;
  }

  const processedUri = await compressPhotoForUpload(photoUri);
  const photo = await readPhotoAsBody(processedUri);
  const contentType = getUploadContentType(processedUri);
  const ext = getUploadExtension(processedUri);
  const nameSlug = coachName ? slugifyPlayerName(coachName) : '';
  const fileName = nameSlug
    ? `${nameSlug}_${Date.now()}.${ext}`
    : `${Date.now()}.${ext}`;
  // Coaches live under a coaches/ prefix so they're easy to audit separately
  const path = `coaches/${orgId}/${coachId}/${fileName}`;
  console.log('[uploadCoachPhoto] path', { path, coachName, nameSlug });

  let lastError: string | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { data, error } = await supabase.storage
        .from(COACH_PHOTOS_BUCKET)
        .upload(path, photo.body, {
          contentType,
          upsert: true,
        });

      if (error || !data) {
        lastError = [
          'COACH UPLOAD FAILED',
          `message: ${error?.message ?? 'unknown error'}`,
          `bucket: ${COACH_PHOTOS_BUCKET}`,
          `path: ${path}`,
          `contentType: ${contentType}`,
          `size: ${photo.size}`,
          `source: ${photo.source}`,
          `platform: ${Platform.OS}`,
          `attempt: ${attempt}/${maxRetries}`,
        ].join('\n');

        if (attempt < maxRetries) {
          await new Promise((res) => setTimeout(res, 800 * attempt));
          continue;
        }

        throw new Error(lastError);
      }

      const { data: pub } = supabase.storage
        .from(COACH_PHOTOS_BUCKET)
        .getPublicUrl(data.path);

      if (!pub?.publicUrl) {
        throw new Error(
          [
            'COACH UPLOAD SUCCEEDED BUT URL FAILED',
            `bucket: ${COACH_PHOTOS_BUCKET}`,
            `path: ${data.path}`,
            `attempt: ${attempt}/${maxRetries}`,
          ].join('\n')
        );
      }

      return pub.publicUrl;
    } catch (err) {
      lastError =
        err instanceof Error
          ? err.message
          : [
              'COACH UPLOAD FAILED',
              `message: ${String(err)}`,
              `bucket: ${COACH_PHOTOS_BUCKET}`,
              `path: ${path}`,
              `contentType: ${contentType}`,
              `size: ${photo.size}`,
              `source: ${photo.source}`,
              `platform: ${Platform.OS}`,
              `attempt: ${attempt}/${maxRetries}`,
            ].join('\n');

      if (attempt < maxRetries) {
        await new Promise((res) => setTimeout(res, 800 * attempt));
        continue;
      }

      throw new Error(lastError);
    }
  }

  throw new Error(lastError ?? 'COACH UPLOAD FAILED\nmessage: unknown error');
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