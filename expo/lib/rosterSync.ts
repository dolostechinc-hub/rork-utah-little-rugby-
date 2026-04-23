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
  calculated_age_group: string | null;
  updated_at?: string;
  updated_by?: string | null;
}

const VALID_RESTRICTIONS: RestrictionStatus[] = [
  'none',
  'penny_player',
  'play_up',
  'open_division',
];

export function rowToPlayer(row: RosterPlayerRow): Player {
  const restriction = (row.restriction_status ?? 'none') as RestrictionStatus;
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
    restrictionStatus: VALID_RESTRICTIONS.includes(restriction) ? restriction : 'none',
    calculatedAgeGroup: row.calculated_age_group ?? undefined,
  };
}

export function playerToRow(
  orgId: string,
  player: Player,
  updatedBy?: string,
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
    photo_uri: player.photoUri ?? null,
    weight: player.weight ?? '',
    checked_in: !!player.checkedIn,
    checked_in_at: player.checkedInAt ?? null,
    restriction_status: player.restrictionStatus ?? 'none',
    calculated_age_group: player.calculatedAgeGroup ?? null,
    updated_by: updatedBy ?? null,
  };
}

export async function fetchRoster(orgId: string): Promise<Player[]> {
  if (!orgId) return [];
  console.log('[rosterSync] fetching roster for org', orgId);
  const { data, error } = await supabase
    .from('roster_players')
    .select('*')
    .eq('org_id', orgId);

  if (error) {
    console.warn('[rosterSync] fetchRoster failed:', error.message);
    throw error;
  }
  const rows = (data ?? []) as RosterPlayerRow[];
  console.log('[rosterSync] fetched roster rows:', rows.length);
  return rows.map(rowToPlayer);
}

export async function upsertRosterPlayer(
  orgId: string,
  player: Player,
  updatedBy?: string,
): Promise<void> {
  if (!orgId || !player?.id) return;
  const row = playerToRow(orgId, player, updatedBy);
  const { error } = await supabase
    .from('roster_players')
    .upsert(row, { onConflict: 'id' });
  if (error) {
    console.warn('[rosterSync] upsert failed:', error.message, player.id);
    throw error;
  }
}

export async function upsertRosterPlayers(
  orgId: string,
  players: Player[],
  updatedBy?: string,
): Promise<void> {
  if (!orgId || players.length === 0) return;
  const rows = players.map((p) => playerToRow(orgId, p, updatedBy));
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const { error } = await supabase
      .from('roster_players')
      .upsert(slice, { onConflict: 'id' });
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
