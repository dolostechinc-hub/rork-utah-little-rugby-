import AsyncStorage from '@react-native-async-storage/async-storage';
import { uploadPlayerPhoto } from './supabase';

// Audit Medium #2:
//
// Previously, `player/[id].tsx handleSave` awaited the Supabase photo
// upload before saving the local check-in. If the device was offline or
// flaky, the upload threw and the function returned early — so the
// volunteer thought a player was checked in, but nothing was persisted
// locally and nothing was queued for Supabase.
//
// This queue lets the screen save the check-in immediately with the local
// `file://` URI, then hand the upload off to a background drain. When the
// upload eventually succeeds, the registered onSuccess callback patches
// the player's `photoUri` to the cloud URL and re-syncs the row through
// the regular cloud sync queue.

export interface PhotoUploadItem {
  id: string;
  orgId: string;
  playerId: string;
  // Local file:// URI on the device. Stays valid as long as the file
  // exists in app storage (Expo image picker copies into a stable cache).
  localUri: string;
  // Optional human-readable name used to slugify the storage path.
  playerName?: string;
  retries: number;
  enqueuedAt: string;
  lastTriedAt?: string;
  lastError?: string;
}

const QUEUE_KEY_PREFIX = 'photo_upload_queue';

function queueKey(orgId: string): string {
  return `${QUEUE_KEY_PREFIX}:${orgId}`;
}

function makeItemId(): string {
  return `pup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function loadPhotoUploadQueue(orgId: string): Promise<PhotoUploadItem[]> {
  if (!orgId) return [];
  try {
    const raw = await AsyncStorage.getItem(queueKey(orgId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PhotoUploadItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('[photoUploadQueue] load failed:', err);
    return [];
  }
}

export async function savePhotoUploadQueue(
  orgId: string,
  items: PhotoUploadItem[],
): Promise<void> {
  if (!orgId) return;
  try {
    await AsyncStorage.setItem(queueKey(orgId), JSON.stringify(items));
  } catch (err) {
    console.warn('[photoUploadQueue] save failed:', err);
  }
}

export function buildPhotoUploadItem(
  orgId: string,
  playerId: string,
  localUri: string,
  playerName?: string,
): PhotoUploadItem {
  return {
    id: makeItemId(),
    orgId,
    playerId,
    localUri,
    playerName,
    retries: 0,
    enqueuedAt: new Date().toISOString(),
  };
}

/**
 * Replace any pending upload for the same player with the latest one.
 * Volunteers retake photos all the time; only the most recent matters.
 */
export function mergeIntoPhotoQueue(
  queue: PhotoUploadItem[],
  incoming: PhotoUploadItem,
): PhotoUploadItem[] {
  const filtered = queue.filter((q) => q.playerId !== incoming.playerId);
  return [...filtered, incoming];
}

export interface PhotoFlushResult {
  uploaded: { itemId: string; playerId: string; cloudUrl: string }[];
  failed: { itemId: string; playerId: string; error: string }[];
}

/**
 * Try to upload every queued item exactly once. Caller owns retry policy
 * (currently: persist the failed items back into AsyncStorage with an
 * incremented retries count, and let launch / network-reconnect / save
 * triggers re-invoke this function).
 */
export async function flushPhotoUploadQueue(
  orgId: string,
  items: PhotoUploadItem[],
): Promise<PhotoFlushResult> {
  const result: PhotoFlushResult = { uploaded: [], failed: [] };
  if (!orgId || items.length === 0) return result;

  for (const item of items) {
    try {
      // The local URI may already be a cloud URL if a previous flush
      // partially succeeded but wasn't dequeued (e.g. the patch-back
      // failed). Skip the upload work and just report success in that
      // case so the caller can finish the patch.
      if (item.localUri.startsWith('http')) {
        result.uploaded.push({
          itemId: item.id,
          playerId: item.playerId,
          cloudUrl: item.localUri,
        });
        continue;
      }

      const cloudUrl = await uploadPlayerPhoto(
        item.playerId,
        item.localUri,
        item.orgId,
        2,
        item.playerName,
      );
      result.uploaded.push({
        itemId: item.id,
        playerId: item.playerId,
        cloudUrl,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[photoUploadQueue] upload failed for', item.playerId, message);
      result.failed.push({
        itemId: item.id,
        playerId: item.playerId,
        error: message,
      });
    }
  }

  return result;
}
