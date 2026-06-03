import { supabase } from './supabase';
import type { Player, RestrictionStatus } from '@/types';

export interface RosterPlayerRow {
  id: string;
  org_id: string;
  first_name: string;
  last_name: string;
  club: string | null;
  age_group: string | null;
  division: string | null;
  team_name: string | null;
  date_of_birth: string | null;
  parent_name: string | null;
  parent_phone: string | null;
  is_age_verified: boolean | null;
  photo_uri: string | null;
  weight: string | null;
  checked_in: boolean | null;
  checked_in_at: string | null;
  restriction_status: string | null;
  // Migration 046 split the legacy 'play_up' enum value out of
  // restriction_status into its own boolean column. Older clients may
  // not see this column on cold reads (PostgREST will just omit it),
  // so the row->player mapper treats it as optional.
  plays_up?: boolean | null;
  calculated_age_group: string | null;
  // Server-managed: rewritten by the touch_roster_players_updated_at trigger
  // on every write. Useful for replication ordering, NOT for "did the local
  // edit win?" decisions.
  updated_at?: string;
  // Client-managed: never touched by the trigger. The app sets this to the
  // monotonic local-edit timestamp so a queued local edit can be compared
  // against the latest cloud copy without the trigger lying about it.
  client_updated_at?: string;
  updated_by?: string | null;
}

const VALID_RESTRICTIONS: RestrictionStatus[] = [
  'none',
  'penny_player',
  'open_division',
];

export function rowToPlayer(row: RosterPlayerRow): Player {
  const rawRestriction = (row.restriction_status ?? 'none') as string;
  // Pre-046 rows may still carry 'play_up' until they're rewritten by
  // the migration. Treat that as plays_up=true with the contact rule
  // defaulted to 'none', matching the new model.
  const isLegacyPlayUp = rawRestriction === 'play_up';
  const restriction: RestrictionStatus = isLegacyPlayUp
    ? 'none'
    : (VALID_RESTRICTIONS.includes(rawRestriction as RestrictionStatus)
        ? (rawRestriction as RestrictionStatus)
        : 'none');
  return {
    id: row.id,
    firstName: row.first_name ?? '',
    lastName: row.last_name ?? '',
    club: row.club ?? '',
    ageGroup: row.age_group ?? '',
    division: row.division ?? '',
    teamName: row.team_name ?? '',
    dateOfBirth: row.date_of_birth ?? '',
    parentName: row.parent_name ?? '',
    parentPhone: row.parent_phone ?? '',
    isAgeVerified: !!row.is_age_verified,
    photoUri: row.photo_uri ?? null,
    weight: row.weight ?? '',
    checkedIn: !!row.checked_in,
    checkedInAt: row.checked_in_at ?? null,
    restrictionStatus: restriction,
    playsUp: row.plays_up ?? isLegacyPlayUp,
    calculatedAgeGroup: row.calculated_age_group ?? undefined,
  };
}

/**
 * A photoUri is "shareable" (and worth writing to the cloud row) only if
 * it's an https/http URL. Local URIs like `file:///...` are device-only
 * and shouldn't be sent to other devices via Supabase. The photo upload
 * queue will replace this with the real cloud URL once the upload
 * completes, then call upsert again.
 */
function shareablePhotoUri(uri: string | null | undefined): string | null {
  if (!uri) return null;
  if (uri.startsWith('http://') || uri.startsWith('https://')) return uri;
  return null;
}

export function playerToRow(
  orgId: string,
  player: Player,
  updatedBy?: string,
  clientUpdatedAt?: string,
): Omit<RosterPlayerRow, 'updated_at'> {
  return {
    id: player.id,
    org_id: orgId,
    first_name: player.firstName ?? '',
    last_name: player.lastName ?? '',
    club: player.club ?? '',
    age_group: player.ageGroup ?? '',
    division: player.division ?? '',
    team_name: player.teamName ?? '',
    date_of_birth: player.dateOfBirth ?? '',
    parent_name: player.parentName ?? '',
    parent_phone: player.parentPhone ?? '',
    is_age_verified: !!player.isAgeVerified,
    photo_uri: shareablePhotoUri(player.photoUri),
    weight: player.weight ?? '',
    checked_in: !!player.checkedIn,
    checked_in_at: player.checkedInAt ?? null,
    restriction_status: player.restrictionStatus ?? 'none',
    plays_up: !!player.playsUp,
    calculated_age_group: player.calculatedAgeGroup ?? null,
    client_updated_at: clientUpdatedAt ?? new Date().toISOString(),
    updated_by: updatedBy ?? null,
  };
}

// Supabase / PostgREST caps a single `select()` response at 1000 rows by
// default (configurable on the project, but we can't rely on it). Larger
// rosters MUST be paginated; otherwise we silently truncate and the merge
// step thinks rows past 1000 don't exist on the server, then sometimes
// "reconciles" by deleting them. We page in fixed-size chunks ordered by a
// stable key so realtime races can't shift rows between pages.
const ROSTER_PAGE_SIZE = 1000;

// Timeout wrapper so stalled Supabase calls don't hang the app indefinitely.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const timeout = new Promise<never>((_resolve, reject) =>
    setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms),
  );
  return Promise.race([promise, timeout]);
}

const QUERY_TIMEOUT_MS = 20000; // 20s per page fetch

export async function fetchRoster(orgId: string): Promise<Player[]> {
  if (!orgId) return [];
  console.log('[rosterSync] fetching roster for org', orgId);

  const all: RosterPlayerRow[] = [];
  let from = 0;

  while (true) {
    const to = from + ROSTER_PAGE_SIZE - 1;
    const q = supabase
      .from('roster_players')
      .select('*')
      .eq('org_id', orgId)
      // Stable sort key so subsequent pages are deterministic even if
      // rows are written concurrently. id is unique within an org under
      // the migration 024 composite PK, so it's a safe order key.
      .order('id', { ascending: true })
      .range(from, to);
    const { data, error } = await withTimeout(q, QUERY_TIMEOUT_MS, `fetchRoster page ${from}-${to}`);

    if (error) {
      console.warn('[rosterSync] fetchRoster failed:', error.message, { from, to });
      throw error;
    }

    const rows = (data ?? []) as RosterPlayerRow[];
    all.push(...rows);

    // Last page when we received fewer rows than we asked for.
    if (rows.length < ROSTER_PAGE_SIZE) break;
    from += ROSTER_PAGE_SIZE;

    // Safety cap so a runaway response loop can't hang the app. 100k
    // rows per org is well above any realistic league size.
    if (all.length >= 100_000) {
      console.warn('[rosterSync] fetchRoster hit safety cap of 100k rows', { orgId });
      break;
    }
  }

  console.log('[rosterSync] fetched roster rows:', all.length);
  return all.map(rowToPlayer);
}

export async function upsertRosterPlayer(
  orgId: string,
  player: Player,
  updatedBy?: string,
  clientUpdatedAt?: string,
): Promise<void> {
  if (!orgId || !player?.id) return;
  const row = playerToRow(orgId, player, updatedBy, clientUpdatedAt);
  const { error } = await supabase
    .from('roster_players')
    .upsert(row, { onConflict: 'org_id,id' });
  if (error) {
    console.warn('[rosterSync] upsert failed:', error.message, player.id);
    throw error;
  }
}

export async function upsertRosterPlayers(
  orgId: string,
  players: Player[],
  updatedBy?: string,
  clientUpdatedAt?: string,
): Promise<void> {
  if (!orgId || players.length === 0) return;
  const stamp = clientUpdatedAt ?? new Date().toISOString();
  const rows = players.map((p) => playerToRow(orgId, p, updatedBy, stamp));
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const { error } = await supabase
      .from('roster_players')
      .upsert(slice, { onConflict: 'org_id,id' });
    if (error) {
      console.warn('[rosterSync] bulk upsert chunk failed:', error.message, {
        from: i,
        to: i + slice.length,
      });
      throw error;
    }
  }
  console.log('[rosterSync] bulk upserted rows:', rows.length);
}

export async function deleteRosterPlayer(orgId: string, id: string): Promise<void> {
  if (!orgId || !id) return;
  const { error } = await supabase
    .from('roster_players')
    .delete()
    .eq('org_id', orgId)
    .eq('id', id);
  if (error) {
    console.warn('[rosterSync] delete failed:', error.message, id);
  }
}

export type RosterChange =
  | { kind: 'upsert'; player: Player }
  | { kind: 'delete'; id: string };

export function subscribeToRoster(
  orgId: string,
  onChange: (change: RosterChange) => void,
): () => void {
  if (!orgId) return () => {};
  console.log('[rosterSync] subscribing to realtime for org', orgId);
  const channel = supabase
    .channel(`roster_players:${orgId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'roster_players',
        filter: `org_id=eq.${orgId}`,
      },
      (payload) => {
        try {
          if (payload.eventType === 'DELETE') {
            const oldRow = payload.old as Partial<RosterPlayerRow> | null;
            if (oldRow?.id) {
              onChange({ kind: 'delete', id: oldRow.id });
            }
            return;
          }
          const newRow = payload.new as RosterPlayerRow | null;
          if (newRow?.id) {
            onChange({ kind: 'upsert', player: rowToPlayer(newRow) });
          }
        } catch (err) {
          console.warn('[rosterSync] realtime handler failed:', err);
        }
      },
    )
    .subscribe((status) => {
      console.log('[rosterSync] channel status:', status);
    });

  return () => {
    console.log('[rosterSync] unsubscribing roster channel for org', orgId);
    try {
      supabase.removeChannel(channel);
    } catch (err) {
      console.warn('[rosterSync] removeChannel failed:', err);
    }
  };
}
