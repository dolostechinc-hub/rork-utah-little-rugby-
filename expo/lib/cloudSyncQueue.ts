import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { playerToRow, rowToPlayer, type RosterPlayerRow } from './rosterSync';
import type { Player } from '@/types';

export interface CloudSyncItem {
  id: string;
  orgId: string;
  playerId: string;
  player: Player;
  // Monotonic local timestamp the client controls. Compared against
  // `roster_players.client_updated_at` (also client-controlled) to decide
  // whether the local edit is newer than the remote copy. We never compare
  // against `updated_at` because the trigger rewrites it on every insert.
  lastEditedAt: string;
  retries: number;
  lastTriedAt?: string;
  lastError?: string;
}

export interface FlushResult {
  // Successfully written exactly as queued.
  synced: string[];
  // Remote was strictly newer per client_updated_at: the queued local row
  // was merged with the remote row field-by-field via `mergeFn` and the
  // merged result was written. The queue item is considered handled.
  merged: string[];
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

interface RemoteSnapshot {
  player: Player;
  clientUpdatedAt: string | null;
}

// Timeout wrapper for supabase queries so stalled network calls don't hang
// the app indefinitely. Using Promise.race with a timeout promise is
// compatible with React Native Hermes (no AbortController requirement).
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const timeout = new Promise<never>((_resolve, reject) =>
    setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms),
  );
  return Promise.race([promise, timeout]);
}

const QUERY_TIMEOUT_MS = 15000; // 15s per chunk / upsert

async function fetchRemoteSnapshots(
  orgId: string,
  playerIds: string[],
): Promise<Map<string, RemoteSnapshot>> {
  const out = new Map<string, RemoteSnapshot>();
  if (playerIds.length === 0) return out;
  const CHUNK = 200;
  for (let i = 0; i < playerIds.length; i += CHUNK) {
    const slice = playerIds.slice(i, i + CHUNK);
    // We need the full row so we can do a per-field merge when remote is
    // newer. Pulling the whole row in 200-id chunks keeps the request
    // small enough to stay within Supabase's row-limit defaults.
    try {
      const q = supabase
        .from('roster_players')
        .select('*')
        .eq('org_id', orgId)
        .in('id', slice);
      const { data, error } = await withTimeout(q, QUERY_TIMEOUT_MS, `fetchRemoteSnapshots chunk ${i}`);
      if (error) {
        console.warn('[cloudSyncQueue] fetchRemoteSnapshots chunk failed:', error.message);
        continue;
      }
      for (const row of (data ?? []) as RosterPlayerRow[]) {
        if (!row?.id) continue;
        out.set(row.id, {
          player: rowToPlayer(row),
          clientUpdatedAt: row.client_updated_at ?? row.updated_at ?? null,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[cloudSyncQueue] fetchRemoteSnapshots chunk errored:', message);
      throw err; // propagate timeout so flushCloudSyncQueue can handle it
    }
  }
  return out;
}

export type PlayerMergeFn = (local: Player, remote: Player) => Player;

/**
 * Try to push every queue item to Supabase using newest-wins semantics.
 *
 * For each item:
 *   - If no remote row exists, push the local row as-is.
 *   - If the local edit is newer (per client_updated_at), push the local row.
 *   - If the remote row is newer, merge per-field via `mergeFn` and push the
 *     merged result. The queue item is then reported in `merged` so the
 *     caller can drop it from the queue without losing local fields like
 *     check-in / photo / weight that the remote row didn't have.
 */
export async function flushCloudSyncQueue(
  orgId: string,
  items: CloudSyncItem[],
  mergeFn: PlayerMergeFn,
  updatedBy?: string,
): Promise<FlushResult> {
  const result: FlushResult = { synced: [], merged: [], failed: [] };
  if (!orgId || items.length === 0) return result;

  const playerIds = Array.from(new Set(items.map((i) => i.playerId)));
  let remoteMap = new Map<string, RemoteSnapshot>();
  try {
    remoteMap = await fetchRemoteSnapshots(orgId, playerIds);
  } catch (err) {
    console.warn(
      '[cloudSyncQueue] fetchRemoteSnapshots failed, will push without comparing:',
      err,
    );
  }

  for (const item of items) {
    const remote = remoteMap.get(item.playerId);
    const localTs = Date.parse(item.lastEditedAt) || 0;
    const remoteTs = remote?.clientUpdatedAt
      ? Date.parse(remote.clientUpdatedAt) || 0
      : 0;

    let toPush: Player = item.player;
    let kind: 'synced' | 'merged' = 'synced';

    if (remote && remoteTs > localTs) {
      // Remote is newer per client clock. Merge field-by-field so we don't
      // throw away local-only data (e.g. a freshly captured photo or
      // weight that hasn't reached the server yet) just because someone
      // else made an edit later.
      try {
        // Argument order matches mergePlayerRecords(local, remote): empty
        // fields on `local` fall back to `remote`, but `local` wins when
        // both are populated. We pass remote first to preserve newer
        // strings while still letting any local-only fields survive.
        toPush = mergeFn(remote.player, item.player);
        kind = 'merged';
        console.log(
          '[cloudSyncQueue] remote newer, merging instead of skipping for',
          item.playerId,
          'local=',
          item.lastEditedAt,
          'remoteClient=',
          remote.clientUpdatedAt,
        );
      } catch (mergeErr) {
        console.warn('[cloudSyncQueue] mergeFn threw, falling back to local push:', mergeErr);
      }
    }

    // Always stamp client_updated_at to "now" on the row we actually
    // write. That way the next device that reads the row sees that we
    // (the merger) are the latest authoritative writer; if we kept the
    // remote's older timestamp, we'd risk an infinite merge loop.
    const writeStamp = new Date().toISOString();
    const row = playerToRow(orgId, toPush, updatedBy, writeStamp);

    try {
      const q = supabase
        .from('roster_players')
        .upsert(row, { onConflict: 'org_id,id' });
      const { error } = await withTimeout(q, QUERY_TIMEOUT_MS, `upsert player ${item.playerId}`);
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
      if (kind === 'synced') result.synced.push(item.id);
      else result.merged.push(item.id);
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
 * Push every player in the local roster to Supabase, applying the same
 * merge semantics as the regular queue flush. Used by the "Force Sync Now"
 * button so a volunteer can flush everything even if the queue lost track
 * of a change.
 */
export async function forcePushAllPlayers(
  orgId: string,
  players: Player[],
  mergeFn: PlayerMergeFn,
  updatedBy?: string,
): Promise<FlushResult> {
  const items: CloudSyncItem[] = players.map((p) =>
    buildItem(orgId, p, new Date().toISOString()),
  );
  return flushCloudSyncQueue(orgId, items, mergeFn, updatedBy);
}
