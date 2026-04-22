import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { decode as decodeBase64 } from 'base64-arraybuffer';
import { supabase, compressPhotoForUpload } from '@/lib/supabase';
import type { Player, RestrictionStatus } from '@/types';

export const PLAYER_PHOTOS_BUCKET_PRIVATE = 'player-photos';

// ----------------------------------------------------------------------------
// Row shape as returned by Supabase (snake_case + legacy columns).
// ----------------------------------------------------------------------------
export interface PlayerRow {
  id: string;
  external_player_id: string | null;
  first_name: string;
  last_name: string;
  club: string | null;
  club_id: string | null;
  age_group: string | null;
  age_group_id: string | null;
  division: string | null;
  division_id: string | null;
  team_id: string | null;
  date_of_birth: string | null;
  parent_name: string | null;
  parent_phone: string | null;
  is_age_verified: boolean | null;
  current_weight_lbs: number | null;
  weight: string | null;
  checked_in: boolean | null;
  checked_in_at: string | null;
  restriction_status: string | null;
  calculated_age_group: string | null;
  photo_path: string | null;
  photo_uri: string | null;
  source_sheet_id: string | null;
  source_row_number: number | null;
  org_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

// ----------------------------------------------------------------------------
// Mappers
// ----------------------------------------------------------------------------
function publicUrlForPath(path: string | null | undefined): string | null {
  if (!path) return null;
  if (path.startsWith('http')) return path;
  try {
    const { data } = supabase.storage
      .from(PLAYER_PHOTOS_BUCKET_PRIVATE)
      .getPublicUrl(path);
    return data?.publicUrl ?? null;
  } catch {
    return null;
  }
}

export function rowToPlayer(row: PlayerRow): Player {
  const photoFromPath = publicUrlForPath(row.photo_path);
  const photo = photoFromPath || row.photo_uri || null;

  const weight =
    row.current_weight_lbs != null
      ? String(row.current_weight_lbs)
      : (row.weight ?? '');

  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    club: row.club ?? '',
    ageGroup: row.age_group ?? '',
    division: row.division ?? '',
    teamName: '',
    dateOfBirth: row.date_of_birth ?? '',
    parentName: row.parent_name ?? '',
    parentPhone: row.parent_phone ?? '',
    isAgeVerified: !!row.is_age_verified,
    photoUri: photo,
    weight,
    checkedIn: !!row.checked_in,
    checkedInAt: row.checked_in_at ?? null,
    restrictionStatus: (row.restriction_status as RestrictionStatus) ?? 'none',
    calculatedAgeGroup: row.calculated_age_group ?? undefined,
  };
}

// ----------------------------------------------------------------------------
// Filters
// ----------------------------------------------------------------------------
export interface PlayerFilters {
  orgId?: string | null;
  club?: string | null;
  ageGroup?: string | null;
  division?: string | null;
  teamId?: string | null;
  checkedIn?: boolean | null;
  restrictionStatus?: RestrictionStatus | null;
  search?: string | null;
}

export async function getPlayers(
  filters: PlayerFilters = {}
): Promise<Player[]> {
  console.log('[player-repo] getPlayers', filters);
  let q = supabase.from('players').select('*');

  if (filters.orgId) q = q.eq('org_id', filters.orgId);
  if (filters.club) q = q.eq('club', filters.club);
  if (filters.ageGroup) q = q.eq('age_group', filters.ageGroup);
  if (filters.division) q = q.eq('division', filters.division);
  if (filters.teamId) q = q.eq('team_id', filters.teamId);
  if (typeof filters.checkedIn === 'boolean')
    q = q.eq('checked_in', filters.checkedIn);
  if (filters.restrictionStatus)
    q = q.eq('restriction_status', filters.restrictionStatus);
  if (filters.search && filters.search.trim()) {
    const s = filters.search.trim();
    q = q.or(`first_name.ilike.%${s}%,last_name.ilike.%${s}%`);
  }

  const { data, error } = await q
    .order('last_name', { ascending: true })
    .order('first_name', { ascending: true });

  if (error) {
    console.error('[player-repo] getPlayers failed', error);
    throw error;
  }

  return (data ?? []).map(rowToPlayer);
}

export async function getPlayerById(id: string): Promise<Player | null> {
  const { data, error } = await supabase
    .from('players')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error('[player-repo] getPlayerById failed', error);
    throw error;
  }
  return data ? rowToPlayer(data as PlayerRow) : null;
}

// ----------------------------------------------------------------------------
// Photo upload (private bucket, stores path)
// ----------------------------------------------------------------------------
async function readPhotoAsBody(
  photoUri: string
): Promise<{ body: ArrayBuffer | Blob; size: number }> {
  if (Platform.OS === 'web') {
    const res = await fetch(photoUri);
    const blob = await res.blob();
    return { body: blob, size: blob.size };
  }

  try {
    const base64 = await FileSystem.readAsStringAsync(photoUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    if (base64) {
      const ab = decodeBase64(base64);
      return { body: ab, size: ab.byteLength };
    }
  } catch (err) {
    console.warn('[player-repo] base64 read failed, falling back', err);
  }

  const res = await fetch(photoUri);
  const blob = await res.blob();
  return { body: blob, size: blob.size };
}

export interface UploadResult {
  path: string;
  publicUrl: string | null;
}

export async function uploadPlayerPhoto(
  playerId: string,
  photoUri: string,
  orgId: string = 'default'
): Promise<UploadResult> {
  if (!photoUri) throw new Error('No photo URI provided');
  if (photoUri.startsWith('http')) {
    return { path: photoUri, publicUrl: photoUri };
  }

  const processed = await compressPhotoForUpload(photoUri);
  const { body } = await readPhotoAsBody(processed);

  const ext = (processed.split('.').pop() || 'jpg').toLowerCase();
  const safeExt = ext === 'heic' || ext === 'heif' || ext === 'jpeg' ? 'jpg' : ext;
  const path = `${orgId}/${playerId}/${Date.now()}.${safeExt}`;
  const contentType = safeExt === 'png' ? 'image/png' : 'image/jpeg';

  const { error } = await supabase.storage
    .from(PLAYER_PHOTOS_BUCKET_PRIVATE)
    .upload(path, body, { contentType, upsert: true });

  if (error) {
    console.error('[player-repo] uploadPlayerPhoto failed', error);
    throw new Error(`Photo upload failed: ${error.message}`);
  }

  const { data } = supabase.storage
    .from(PLAYER_PHOTOS_BUCKET_PRIVATE)
    .getPublicUrl(path);

  return { path, publicUrl: data?.publicUrl ?? null };
}

// ----------------------------------------------------------------------------
// Check-in update
// ----------------------------------------------------------------------------
export interface CheckInUpdate {
  playerId: string;
  weightLbs?: number | null;
  isAgeVerified?: boolean;
  restrictionStatus?: RestrictionStatus;
  calculatedAgeGroup?: string | null;
  photoPath?: string | null;
  photoUrl?: string | null;
  markCheckedIn?: boolean;
}

export async function updatePlayerCheckIn(
  update: CheckInUpdate
): Promise<Player> {
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    updated_at: now,
  };

  if (typeof update.weightLbs === 'number') {
    patch.current_weight_lbs = update.weightLbs;
    patch.weight = String(update.weightLbs);
  }
  if (typeof update.isAgeVerified === 'boolean')
    patch.is_age_verified = update.isAgeVerified;
  if (update.restrictionStatus)
    patch.restriction_status = update.restrictionStatus;
  if (update.calculatedAgeGroup !== undefined)
    patch.calculated_age_group = update.calculatedAgeGroup;
  if (update.photoPath !== undefined) patch.photo_path = update.photoPath;
  if (update.photoUrl !== undefined) patch.photo_uri = update.photoUrl;
  if (update.markCheckedIn) {
    patch.checked_in = true;
    patch.checked_in_at = now;
  }

  console.log('[player-repo] updatePlayerCheckIn', update.playerId, patch);

  const { data, error } = await supabase
    .from('players')
    .update(patch)
    .eq('id', update.playerId)
    .select('*')
    .single();

  if (error) {
    console.error('[player-repo] updatePlayerCheckIn failed', error);
    throw error;
  }

  // Write audit row (best-effort; do not block on failure).
  try {
    await supabase.from('check_in_events').insert({
      player_id: update.playerId,
      measured_weight_lbs:
        typeof update.weightLbs === 'number' ? update.weightLbs : null,
      age_verified: !!update.isAgeVerified,
      restriction_status: update.restrictionStatus ?? 'none',
      photo_path: update.photoPath ?? null,
      checked_in_at: now,
    });
  } catch (err) {
    console.warn('[player-repo] audit insert failed (non-fatal)', err);
  }

  return rowToPlayer(data as PlayerRow);
}

// ----------------------------------------------------------------------------
// Realtime
// ----------------------------------------------------------------------------
export function subscribeToPlayers(
  onChange: (payload: { eventType: string; row: PlayerRow | null }) => void
): () => void {
  console.log('[player-repo] subscribeToPlayers');
  const channel = supabase
    .channel('players-live')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'players' },
      (payload) => {
        const row = (payload.new ?? payload.old) as PlayerRow | null;
        onChange({ eventType: payload.eventType, row });
      }
    )
    .subscribe((status) => {
      console.log('[player-repo] realtime status:', status);
    });

  return () => {
    try {
      void supabase.removeChannel(channel);
    } catch (err) {
      console.warn('[player-repo] removeChannel failed', err);
    }
  };
}
