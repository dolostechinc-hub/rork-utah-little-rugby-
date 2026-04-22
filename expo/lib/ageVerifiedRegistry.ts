import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '@/lib/supabase';

const CACHE_KEY_PREFIX = 'age_verified_registry_cache_';

export function normalizeVerificationKey(
  firstName: string,
  lastName: string,
  dateOfBirth: string
): string {
  const first = (firstName || '').toLowerCase().trim();
  const last = (lastName || '').toLowerCase().trim();
  const dob = (dateOfBirth || '').trim();
  if (!first || !last || !dob) return '';
  return `${first}__${last}__${dob}`;
}

export interface AgeVerifiedEntry {
  normalizedKey: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  verifiedAt: string;
  verifiedBy: string | null;
}

function cacheKeyForOrg(orgId: string): string {
  return `${CACHE_KEY_PREFIX}${orgId || 'default'}`;
}

export async function loadCachedRegistry(orgId: string): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(cacheKeyForOrg(orgId));
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(arr);
  } catch (err) {
    console.warn('[ageVerifiedRegistry] loadCached failed:', err);
    return new Set();
  }
}

async function saveCachedRegistry(orgId: string, keys: Set<string>): Promise<void> {
  try {
    await AsyncStorage.setItem(
      cacheKeyForOrg(orgId),
      JSON.stringify(Array.from(keys))
    );
  } catch (err) {
    console.warn('[ageVerifiedRegistry] saveCached failed:', err);
  }
}

export async function fetchRegistryFromRemote(orgId: string): Promise<Set<string>> {
  if (!orgId) return new Set();
  try {
    console.log('[ageVerifiedRegistry] fetching remote for org:', orgId);
    const { data, error } = await supabase
      .from('age_verified_registry')
      .select('normalized_key')
      .eq('org_id', orgId);

    if (error) {
      console.warn('[ageVerifiedRegistry] remote fetch error:', error.message);
      return new Set();
    }

    const keys = new Set<string>();
    for (const row of data ?? []) {
      const k = (row as { normalized_key: string }).normalized_key;
      if (k) keys.add(k);
    }
    await saveCachedRegistry(orgId, keys);
    console.log('[ageVerifiedRegistry] remote fetch ok, keys:', keys.size);
    return keys;
  } catch (err) {
    console.warn('[ageVerifiedRegistry] remote fetch threw:', err);
    return new Set();
  }
}

export async function markPlayerAgeVerified(
  orgId: string,
  player: {
    firstName: string;
    lastName: string;
    dateOfBirth: string;
  },
  verifiedBy?: string
): Promise<boolean> {
  const normalizedKey = normalizeVerificationKey(
    player.firstName,
    player.lastName,
    player.dateOfBirth
  );
  if (!orgId || !normalizedKey) {
    console.log('[ageVerifiedRegistry] skipping mark - missing data', {
      hasOrg: !!orgId,
      hasKey: !!normalizedKey,
    });
    return false;
  }

  try {
    const existing = await loadCachedRegistry(orgId);
    if (!existing.has(normalizedKey)) {
      existing.add(normalizedKey);
      await saveCachedRegistry(orgId, existing);
    }
  } catch (err) {
    console.warn('[ageVerifiedRegistry] local cache update failed:', err);
  }

  try {
    const { error } = await supabase
      .from('age_verified_registry')
      .upsert(
        {
          org_id: orgId,
          normalized_key: normalizedKey,
          first_name: player.firstName.trim(),
          last_name: player.lastName.trim(),
          date_of_birth: player.dateOfBirth.trim(),
          verified_by: verifiedBy ?? null,
          verified_at: new Date().toISOString(),
        },
        { onConflict: 'org_id,normalized_key' }
      );

    if (error) {
      console.warn('[ageVerifiedRegistry] upsert error:', error.message);
      return false;
    }
    console.log('[ageVerifiedRegistry] upserted:', normalizedKey);
    return true;
  } catch (err) {
    console.warn('[ageVerifiedRegistry] upsert threw:', err);
    return false;
  }
}

export function isPlayerInRegistrySet(
  set: Set<string>,
  player: { firstName: string; lastName: string; dateOfBirth: string }
): boolean {
  const key = normalizeVerificationKey(
    player.firstName,
    player.lastName,
    player.dateOfBirth
  );
  if (!key) return false;
  return set.has(key);
}
