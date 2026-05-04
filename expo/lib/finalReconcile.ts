import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { fetchRoster } from './rosterSync';
import {
  flushCloudSyncQueue,
  type CloudSyncItem,
  type PlayerMergeFn,
} from './cloudSyncQueue';
import type { Player } from '@/types';

const PLAYERS_KEY_PREFIX = 'registration_players:';
// Per-org reconcile flag. Audit Medium #1: the previous flag was global, so
// once any org on the device ran reconcile, every other org silently
// skipped its own sweep (and never pushed older local caches up). Scoping
// the flag by org id makes this work for multi-org devices.
const RECONCILE_FLAG_KEY_PREFIX = 'final_reconcile_v2_done';
const LEGACY_GLOBAL_RECONCILE_FLAG_KEY = 'final_reconcile_v2_done';

function reconcileFlagKey(orgId: string): string {
  return `${RECONCILE_FLAG_KEY_PREFIX}:${orgId}`;
}

export interface ReconcileResult {
  ok: boolean;
  scopesScanned: number;
  localPlayersCollected: number;
  cloudOrgsFound: number;
  cloudPlayersCollected: number;
  mergedTotal: number;
  pushed: number;
  skipped: number;
  failed: number;
  canonicalOrgId: string;
  duplicateOrgIdsMerged: string[];
  error?: string;
}

interface DedupeFn {
  (list: Player[]): { deduped: Player[]; duplicateIds: string[] };
}

function safeParsePlayers(raw: string | null): Player[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as Player[];
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    console.warn('[finalReconcile] failed to parse players blob:', err);
    return [];
  }
}

async function gatherAllLocalPlayers(): Promise<{ players: Player[]; scopes: string[] }> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const playerKeys = keys.filter((k) => k.startsWith(PLAYERS_KEY_PREFIX));
    let collected: Player[] = [];
    for (const k of playerKeys) {
      const raw = await AsyncStorage.getItem(k);
      const arr = safeParsePlayers(raw);
      if (arr.length > 0) {
        console.log('[finalReconcile] scope', k, '->', arr.length, 'players');
        collected = collected.concat(arr);
      }
    }
    return { players: collected, scopes: [...playerKeys] };
  } catch (err) {
    console.warn('[finalReconcile] gatherAllLocalPlayers failed:', err);
    return { players: [], scopes: [] };
  }
}

async function findCloudOrgIdsByCode(code: string, fallbackId: string): Promise<string[]> {
  const ids = new Set<string>();
  ids.add(fallbackId);
  try {
    const { data, error } = await supabase
      .from('organizations')
      .select('id, code')
      .ilike('code', code.toUpperCase().trim());
    if (error) {
      console.warn('[finalReconcile] cloud org lookup failed:', error.message);
    } else {
      for (const row of (data ?? []) as { id: string }[]) {
        if (row.id) ids.add(row.id);
      }
    }
  } catch (err) {
    console.warn('[finalReconcile] cloud org lookup threw:', err);
  }
  return Array.from(ids);
}

async function pullAllCloudRosters(orgIds: string[]): Promise<Player[]> {
  let all: Player[] = [];
  for (const oid of orgIds) {
    try {
      const r = await fetchRoster(oid);
      if (r.length > 0) {
        console.log('[finalReconcile] cloud org', oid, '->', r.length, 'players');
        all = all.concat(r);
      }
    } catch (err) {
      console.warn('[finalReconcile] fetchRoster failed for', oid, err);
    }
  }
  return all;
}

/**
 * One-shot reconcile that runs the "final update" the admin asked for:
 *
 * 1. Sweep every AsyncStorage scope on this device (current org + any
 *    legacy org_ids left over from previous app versions / org id changes).
 * 2. Look up every cloud org that shares the same invite code as the
 *    org the user is currently signed into. If duplicates exist, pull
 *    their rosters too.
 * 3. Combine local + cloud rosters and run the existing dedupe (which
 *    keeps the richest record per name+DOB and merges photos / weight /
 *    check-in / verification flags).
 * 4. Force-push the merged roster to the canonical cloud org with a
 *    "now" timestamp so this update wins over any stale data.
 * 5. Persist the merged roster locally under the canonical org scope.
 *
 * The caller passes in `dedupePlayers` to avoid pulling the entire
 * RegistrationContext into this module.
 */
export async function runFinalReconcile(
  canonicalOrgId: string,
  orgCode: string,
  dedupePlayers: DedupeFn,
  mergeFn: PlayerMergeFn,
): Promise<ReconcileResult> {
  console.log('[finalReconcile] starting for org', orgCode, '->', canonicalOrgId);

  const { players: localPlayers, scopes } = await gatherAllLocalPlayers();

  const cloudOrgIds = await findCloudOrgIdsByCode(orgCode, canonicalOrgId);
  const cloudPlayers = await pullAllCloudRosters(cloudOrgIds);

  const combined = [...cloudPlayers, ...localPlayers];
  const { deduped } = dedupePlayers(combined);
  console.log('[finalReconcile] merged', combined.length, '->', deduped.length, 'unique players');

  const now = new Date().toISOString();
  const items: CloudSyncItem[] = deduped.map((p, idx) => ({
    id: `recon-${now}-${idx}-${p.id}`,
    orgId: canonicalOrgId,
    playerId: p.id,
    player: p,
    lastEditedAt: now,
    retries: 0,
  }));

  let pushed = 0;
  let skipped = 0;
  let failed = 0;
  let lastError: string | undefined;

  if (items.length > 0) {
    try {
      const result = await flushCloudSyncQueue(canonicalOrgId, items, mergeFn);
      pushed = result.synced.length + result.merged.length;
      skipped = 0;
      failed = result.failed.length;
      if (result.failed.length > 0) {
        lastError = result.failed[0]?.error;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.warn('[finalReconcile] flushCloudSyncQueue threw:', lastError);
    }
  }

  try {
    await AsyncStorage.setItem(
      `${PLAYERS_KEY_PREFIX}${canonicalOrgId}`,
      JSON.stringify(deduped),
    );
  } catch (err) {
    console.warn('[finalReconcile] failed to persist merged roster locally:', err);
  }

  try {
    await AsyncStorage.setItem(reconcileFlagKey(canonicalOrgId), now);
  } catch (err) {
    console.warn('[finalReconcile] failed to set reconcile flag:', err);
  }

  const duplicateOrgIdsMerged = cloudOrgIds.filter((id) => id !== canonicalOrgId);

  console.log('[finalReconcile] done', {
    pushed,
    skipped,
    failed,
    cloudOrgsFound: cloudOrgIds.length,
    duplicateOrgIdsMerged,
  });

  return {
    ok: failed === 0,
    scopesScanned: scopes.length,
    localPlayersCollected: localPlayers.length,
    cloudOrgsFound: cloudOrgIds.length,
    cloudPlayersCollected: cloudPlayers.length,
    mergedTotal: deduped.length,
    pushed,
    skipped,
    failed,
    canonicalOrgId,
    duplicateOrgIdsMerged,
    error: lastError,
  };
}

/**
 * Returns the ISO timestamp the reconcile last ran for `orgId`, or null
 * if it hasn't run for this org yet on this device.
 *
 * Honors the legacy global flag from older app versions: if the global
 * flag is set but no per-org flag exists, we treat it as "this org has
 * already been reconciled". That keeps the first launch after upgrade from
 * re-running reconcile on the org the device was last using. Other orgs
 * the device joins will run reconcile fresh, which is the audit fix.
 */
export async function hasReconcileRun(orgId: string): Promise<string | null> {
  try {
    const perOrg = await AsyncStorage.getItem(reconcileFlagKey(orgId));
    if (perOrg) return perOrg;
    const legacy = await AsyncStorage.getItem(LEGACY_GLOBAL_RECONCILE_FLAG_KEY);
    return legacy ?? null;
  } catch {
    return null;
  }
}

export async function clearReconcileFlag(orgId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(reconcileFlagKey(orgId));
  } catch (err) {
    console.warn('[finalReconcile] failed to clear flag:', err);
  }
}

export async function clearAllReconcileFlags(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const targets = keys.filter(
      (k) =>
        k === LEGACY_GLOBAL_RECONCILE_FLAG_KEY ||
        k.startsWith(`${RECONCILE_FLAG_KEY_PREFIX}:`),
    );
    if (targets.length > 0) {
      await AsyncStorage.multiRemove(targets);
    }
  } catch (err) {
    console.warn('[finalReconcile] failed to clear all flags:', err);
  }
}
