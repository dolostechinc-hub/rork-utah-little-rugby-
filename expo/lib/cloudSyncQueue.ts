import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { playerToRow } from './rosterSync';
import type { Player } from '@/types';

export interface CloudSyncItem {
  id: string;
  orgId: string;
  playerId: string;
  player: Player;
  lastEditedAt: string;
  retries: number;
  lastTriedAt?: string;
  lastError?: string;
}

export interface FlushResult {
  synced: string[];
  skipped: string[];
  failed: { itemId: string; playerId: string; error: string }[];
}

const QUEUE_KEY_PREFIX = 'cloud_sync_queue';
const LAST_SYNC_KEY_PREFIX = 'cloud_sync_last_synced_at';

function queueKey(orgId: string): string {
  return `${QUEUE_KEY_PREFIX}:${orgId}`;
}

function lastSyncKey(orgId: string): string {
  return `${LAST_SYNC_KEY_PREFIX}:${orgId}`;
}

export async function loadCloudSyncQueue(orgId: string): Promise<CloudSyncItem[]> {
  if (!orgId) return [];
  try {
    const raw = await AsyncStorage.getItem(queueKey(orgId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CloudSyncItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('[cloudSyncQueue] loadCloudSyncQueue failed:', err);
    return [];
  }
}

export async function saveCloudSyncQueue(
  orgId: string,
  items: CloudSyncItem[],
): Promise<void> {
  if (!orgId) return;
  try {
    await AsyncStorage.setItem(queueKey(orgId), JSON.stringify(items));
  } catch (err) {
    console.warn('[cloudSyncQueue] saveCloudSyncQueue failed:', err);
  }
}

export async function loadLastCloudSync(orgId: string): Promise<string | null> {
  if (!orgId) return null;
  try {
    return (await AsyncStorage.getItem(lastSyncKey(orgId))) ?? null;
  } catch {
    return null;
  }
}

export async function saveLastCloudSync(orgId: string, iso: string): Promise<void> {
  if (!orgId) return;
  try {
    await AsyncStorage.setItem(lastSyncKey(orgId), iso);
  } catch (err) {
    console.warn('[cloudSyncQueue] saveLastCloudSync failed:', err);
  }
}

function makeItemId(): string {
  return `csi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function buildItem(orgId: string, player: Player, lastEditedAt?: string): CloudSyncItem {
  return {
    id: makeItemId(),
    orgId,
    playerId: player.id,
    player,
    lastEditedAt: lastEditedAt ?? new Date().toISOString(),
    retries: 0,
  };
}

/**
 * Merge a new edit into the queue. If a previous item exists for the same
 * player, keep only the newest edit (by lastEditedAt).
 */
export function mergeIntoQueue(
  queue: CloudSyncItem[],
  incoming: CloudSyncItem,
): CloudSyncItem[] {
  const existingIdx = queue.findIndex((q) => q.playerId === incoming.playerId);
  if (existingIdx === -1) return [...queue, incoming];
  const existing = queue[existingIdx];
  const existingTs = Date.parse(existing.lastEditedAt) || 0;
  const incomingTs = Date.parse(incoming.lastEditedAt) || 0;
  if (incomingTs >= existingTs) {
    const next = [...queue];
    next[existingIdx] = { ...incoming, retries: 0 };
    return next;
  }
  return queue;
}

async function fetchRemoteUpdatedAtMap(
  orgId: string,
  playerIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (playerIds.length === 0) return out;
  const CHUNK = 200;
  for (let i = 0; i < playerIds.length; i += CHUNK) {
    const slice = playerIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('roster_players')
      .select('id, updated_at')
      .eq('org_id', orgId)
      .in('id', slice);
    if (error) {
      console.warn('[cloudSyncQueue] fetchRemoteUpdatedAtMap chunk failed:', error.message);
      continue;
    }
    for (const row of (data ?? []) as { id: string; updated_at: string | null }[]) {
      if (row.id && row.updated_at) out.set(row.id, row.updated_at);
    }
  }
  return out;
}

/**
 * Try to push every queue item to Supabase using newest-wins semantics.
 * Returns ids of items that succeeded, were skipped (remote newer), and failed.
 */
export async function flushCloudSyncQueue(
  orgId: string,
  items: CloudSyncItem[],
  updatedBy?: string,
): Promise<FlushResult> {
  const result: FlushResult = { synced: [], skipped: [], failed: [] };
  if (!orgId || items.length === 0) return result;

  const playerIds = Array.from(new Set(items.map((i) => i.playerId)));
  let remoteMap = new Map<string, string>();
  try {
    remoteMap = await fetchRemoteUpdatedAtMap(orgId, playerIds);
  } catch (err) {
    console.warn(
      '[cloudSyncQueue] fetchRemoteUpdatedAtMap failed, will push without comparing:',
      err,
    );
  }

  for (const item of items) {
    const remoteUpdatedAt = remoteMap.get(item.playerId);
    const localTs = Date.parse(item.lastEditedAt) || 0;
    const remoteTs = remoteUpdatedAt ? Date.parse(remoteUpdatedAt) || 0 : 0;
    if (remoteUpdatedAt && remoteTs > localTs) {
      console.log(
        '[cloudSyncQueue] skipping older local edit for',
        item.playerId,
        'local=',
        item.lastEditedAt,
        'remote=',
        remoteUpdatedAt,
      );
      result.skipped.push(item.id);
      continue;
    }

    const row = {
      ...playerToRow(orgId, item.player, updatedBy),
      updated_at: item.lastEditedAt,
    };

    try {
      const { error } = await supabase
        .from('roster_players')
        .upsert(row, { onConflict: 'id' });
      if (error) {
        console.warn(
          '[cloudSyncQueue] upsert failed for',
          item.playerId,
          error.message,
        );
        result.failed.push({
          itemId: item.id,
          playerId: item.playerId,
          error: error.message,
        });
        continue;
      }
      result.synced.push(item.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[cloudSyncQueue] upsert threw for', item.playerId, message);
      result.failed.push({
        itemId: item.id,
        playerId: item.playerId,
        error: message,
      });
    }
  }

  return result;
}

/**
 * Push every player in the local roster to Supabase, applying newest-wins.
 * Used by the "Force Sync Now" button so a volunteer can flush everything
 * even if the queue lost track of a change.
 */
export async function forcePushAllPlayers(
  orgId: string,
  players: Player[],
  updatedBy?: string,
): Promise<FlushResult> {
  const items: CloudSyncItem[] = players.map((p) =>
    buildItem(orgId, p, new Date().toISOString()),
  );
  return flushCloudSyncQueue(orgId, items, updatedBy);
}
