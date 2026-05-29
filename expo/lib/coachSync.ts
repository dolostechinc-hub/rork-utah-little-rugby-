import { supabase } from './supabase';
import type { Coach, CoachTeam } from '@/types';

// ── Row shapes ─────────────────────────────────────────────────────────────

export interface CoachRow {
  id: string;
  org_id: string;
  first_name: string;
  last_name: string;
  photo_uri: string | null;
  is_certified: boolean;
  checked_in: boolean;
  checked_in_at: string | null;
  updated_at?: string;
}

export interface CoachTeamRow {
  id: string;
  coach_id: string;
  org_id: string;
  club: string;
  age_group: string;
  division: string;
  team_name: string;
}

// ── Mappers ────────────────────────────────────────────────────────────────

function rowToCoach(row: CoachRow): Coach {
  return {
    id: row.id,
    firstName: row.first_name ?? '',
    lastName: row.last_name ?? '',
    photoUri: row.photo_uri ?? null,
    isCertified: !!row.is_certified,
    checkedIn: !!row.checked_in,
    checkedInAt: row.checked_in_at ?? null,
  };
}

/**
 * A photoUri is "shareable" (and worth writing to the cloud row) only if
 * it's an https/http URL. Local URIs like `file:///...` are device-only
 * and shouldn't be sent to other devices via Supabase. The photo upload
 * in RegistrationContext will replace this with the real cloud URL before
 * calling upsertCoach; this is a safety net in case a caller bypasses that.
 */
function shareablePhotoUri(uri: string | null | undefined): string | null {
  if (!uri) return null;
  if (uri.startsWith('http://') || uri.startsWith('https://')) return uri;
  return null;
}

function coachToRow(orgId: string, coach: Coach): Omit<CoachRow, 'updated_at'> {
  return {
    id: coach.id,
    org_id: orgId,
    first_name: coach.firstName ?? '',
    last_name: coach.lastName ?? '',
    photo_uri: shareablePhotoUri(coach.photoUri),
    is_certified: !!coach.isCertified,
    checked_in: !!coach.checkedIn,
    checked_in_at: coach.checkedInAt ?? null,
  };
}

function rowToCoachTeam(row: CoachTeamRow): CoachTeam {
  return {
    id: row.id,
    coachId: row.coach_id,
    orgId: row.org_id,
    club: row.club ?? '',
    ageGroup: row.age_group ?? '',
    division: row.division ?? '',
    teamName: row.team_name ?? '',
  };
}

// ── Fetch ──────────────────────────────────────────────────────────────────

export async function fetchCoaches(orgId: string): Promise<Coach[]> {
  if (!orgId) return [];
  const { data, error } = await supabase
    .from('coaches')
    .select('*')
    .eq('org_id', orgId)
    .order('last_name', { ascending: true });

  if (error) {
    console.warn('[coachSync] fetchCoaches failed:', error.message);
    throw error;
  }

  return ((data ?? []) as CoachRow[]).map(rowToCoach);
}

export async function fetchCoachTeams(orgId: string): Promise<CoachTeam[]> {
  if (!orgId) return [];
  const { data, error } = await supabase
    .from('coach_teams')
    .select('*')
    .eq('org_id', orgId);

  if (error) {
    console.warn('[coachSync] fetchCoachTeams failed:', error.message);
    throw error;
  }

  return ((data ?? []) as CoachTeamRow[]).map(rowToCoachTeam);
}

// ── Upsert ─────────────────────────────────────────────────────────────────

export async function upsertCoach(orgId: string, coach: Coach): Promise<void> {
  if (!orgId || !coach?.id) return;
  const row = coachToRow(orgId, coach);
  const { error } = await supabase
    .from('coaches')
    .upsert(row, { onConflict: 'id' });
  if (error) {
    console.warn('[coachSync] upsertCoach failed:', error.message, coach.id);
    throw error;
  }
}

export async function upsertCoachTeams(
  orgId: string,
  coachId: string,
  teams: Omit<CoachTeam, 'id' | 'coachId' | 'orgId'>[],
): Promise<void> {
  if (!orgId || !coachId) return;

  // Delete existing assignments, then re-insert
  const { error: delErr } = await supabase
    .from('coach_teams')
    .delete()
    .eq('coach_id', coachId)
    .eq('org_id', orgId);

  if (delErr) {
    console.warn('[coachSync] delete coach_teams failed:', delErr.message);
  }

  if (teams.length === 0) return;

  const rows: CoachTeamRow[] = teams.map((t) => ({
    id: `${coachId}_${t.teamName.replace(/\s+/g, '_').toLowerCase()}`,
    coach_id: coachId,
    org_id: orgId,
    club: t.club ?? '',
    age_group: t.ageGroup ?? '',
    division: t.division ?? '',
    team_name: t.teamName ?? '',
  }));

  const { error } = await supabase.from('coach_teams').upsert(rows, { onConflict: 'id' });
  if (error) {
    console.warn('[coachSync] upsert coach_teams failed:', error.message);
    throw error;
  }
}

// ── Delete ─────────────────────────────────────────────────────────────────

export async function deleteCoach(orgId: string, coachId: string): Promise<void> {
  if (!orgId || !coachId) return;
  // coach_teams rows cascade via FK ON DELETE CASCADE
  const { error } = await supabase
    .from('coaches')
    .delete()
    .eq('id', coachId)
    .eq('org_id', orgId);
  if (error) {
    console.warn('[coachSync] deleteCoach failed:', error.message, coachId);
    throw error;
  }
}

// ── Realtime subscription ──────────────────────────────────────────────────

export type CoachChange =
  | { kind: 'upsert'; coach: Coach }
  | { kind: 'delete'; id: string };

export function subscribeToCoaches(
  orgId: string,
  onChange: (change: CoachChange) => void,
): () => void {
  if (!orgId) return () => {};

  const channel = supabase
    .channel(`coaches:${orgId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'coaches',
        filter: `org_id=eq.${orgId}`,
      },
      (payload) => {
        try {
          if (payload.eventType === 'DELETE') {
            const oldRow = payload.old as Partial<CoachRow> | null;
            if (oldRow?.id) {
              onChange({ kind: 'delete', id: oldRow.id });
            }
            return;
          }
          const newRow = payload.new as CoachRow | null;
          if (newRow?.id) {
            onChange({ kind: 'upsert', coach: rowToCoach(newRow) });
          }
        } catch (err) {
          console.warn('[coachSync] realtime handler failed:', err);
        }
      },
    )
    .subscribe((status) => {
      console.log('[coachSync] channel status:', status);
    });

  return () => {
    try {
      supabase.removeChannel(channel);
    } catch (err) {
      console.warn('[coachSync] removeChannel failed:', err);
    }
  };
}
