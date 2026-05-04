import { supabase } from './supabase';
import type { Club } from '@/types';

/**
 * Canonical clubs are stored once globally in `public.clubs` (see migration
 * 025). This module is the only place the app should fetch them — every UI
 * dropdown should drive off this list, never off `Player.club` strings, so
 * we don't reintroduce the variant-spelling problem the audit found.
 */

export interface ClubRow {
  id: string;
  name: string;
  is_active?: boolean | null;
}

function rowToClub(row: ClubRow): Club {
  return {
    id: row.id,
    name: row.name,
  };
}

export async function fetchClubs(): Promise<Club[]> {
  console.log('[clubsRepo] fetching canonical clubs');
  // Only select columns we actually need. The `clubs` table may have been
  // created by an earlier (incomplete) migration draft that didn't include
  // every optional column we'd like to surface, so we keep the read narrow
  // and resilient. is_active filtering is guarded so older rows without
  // the column simply pass through.
  const { data, error } = await supabase
    .from('clubs')
    .select('id, name, is_active')
    .order('name', { ascending: true });

  if (error) {
    console.warn('[clubsRepo] fetchClubs failed:', error.message);
    throw error;
  }
  const rows = (data ?? []) as ClubRow[];
  const active = rows.filter((r) => r.is_active !== false);
  console.log('[clubsRepo] fetched clubs:', active.length);
  return active.map(rowToClub);
}
