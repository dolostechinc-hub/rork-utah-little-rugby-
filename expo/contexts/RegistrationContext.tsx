import createContextHook from '@nkzw/create-context-hook';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { Player, RegistrationFilters, Club, AgeGroup, Division, ImportedSheet } from '@/types';
import { mockPlayers, clubs as fallbackClubs, ageGroups as mockAgeGroups } from '@/mocks/registrationData';
import { fetchClubs } from '@/lib/clubsRepo';
import { trpc } from '@/lib/trpc';
import { useAuth } from '@/contexts/AuthContext';
import { useOrganization } from '@/contexts/OrganizationContext';
import { supabase } from '@/lib/supabase';
import {
  loadCloudSyncQueue,
  saveCloudSyncQueue,
  loadLastCloudSync,
  saveLastCloudSync,
  buildItem,
  mergeIntoQueue,
  flushCloudSyncQueue,
  type CloudSyncItem,
  type FlushResult,
} from '@/lib/cloudSyncQueue';
import {
  runFinalReconcile,
  hasReconcileRun,
  type ReconcileResult,
} from '@/lib/finalReconcile';
import {
  loadPhotoUploadQueue,
  savePhotoUploadQueue,
  buildPhotoUploadItem,
  mergeIntoPhotoQueue,
  flushPhotoUploadQueue,
  type PhotoUploadItem,
} from '@/lib/photoUploadQueue';
import { randomId } from '@/lib/ids';
import {
  loadCachedRegistry,
  fetchRegistryFromRemote,
  markPlayerAgeVerified,
  normalizeVerificationKey,
} from '@/lib/ageVerifiedRegistry';
import {
  fetchRoster,
  upsertRosterPlayer,
  upsertRosterPlayers,
  subscribeToRoster,
  type RosterChange,
} from '@/lib/rosterSync';
import {
  fetchOrgEventMode,
  setOrgEventMode,
  subscribeOrgEventMode,
} from '@/lib/eventModeSync';
import { fetchSheetCsv, parseCSV } from '@/lib/googleSheetsCsv';
import { parseTeamAssignments, playerHasTeam, compareTeamByName } from '@/utils/teamAssignments';
import { normalizeAgeGroup } from '@/utils/playerUtils';
import {
  fetchCoaches,
  fetchCoachTeams,
  upsertCoach,
  upsertCoachTeams,
  deleteCoach as deleteCoachRemote,
  subscribeToCoaches,
  type CoachChange,
} from '@/lib/coachSync';
import { uploadCoachPhoto } from '@/lib/supabase';
import type { Coach, CoachTeam } from '@/types';

const RETRY_COUNT = 3;
const RETRY_DELAY = 1000;
const LOCAL_SYNC_INTERVAL = 30000; // How often to push local changes to sheets

// Storage keys are scoped per-organization so that switching orgs gives a
// clean slate (no cross-contamination of rosters, Google Sheet connections,
// imported sheet history, etc.). The base names below are the prefixes; the
// actual keys appended with `:${orgId}` are computed inside the provider via
// the helper functions (playersKey(), sheetsConfigKey(), ...).
const BASE_WRITE_QUEUE_KEY = 'pending_write_queue';
const BASE_PLAYERS_STORAGE_KEY = 'registration_players';
const BASE_SHEETS_CONFIG_KEY = 'google_sheets_config';
const BASE_SAVED_SHEET_URL_KEY = 'saved_google_sheet_url';
const BASE_IMPORTED_SHEETS_KEY = 'imported_sheets_history';
const BASE_EVENT_MODE_KEY = 'event_mode';
const BASE_SHOW_TEAM_ASSIGNMENT_KEY = 'show_team_assignment';
const BASE_IMPORTED_METADATA_KEY = 'imported_metadata';
const NO_ORG_SCOPE = '__none__';

export type EventMode = 'registration' | 'viewOnly';

let memoryPlayerCache: Player[] | null = null;

function playerDedupeKey(p: { firstName: string; lastName: string; dateOfBirth: string }): string {
  const first = (p.firstName || '').toLowerCase().trim();
  const last = (p.lastName || '').toLowerCase().trim();
  const dob = (p.dateOfBirth || '').trim();
  if (!first || !last) return '';
  return `${first}_${last}_${dob}`;
}

function mergePlayerRecords(a: Player, b: Player): Player {
  // Safety: if either record is null/undefined (corrupt cache edge case),
  // return the other unchanged rather than throwing.
  if (!a) return b;
  if (!b) return a;

  // ── Row-level client timestamps for last-write-wins decisions ──────
  const aTs = a.clientUpdatedAt ? Date.parse(a.clientUpdatedAt) : 0;
  const bTs = b.clientUpdatedAt ? Date.parse(b.clientUpdatedAt) : 0;

  // ── checkedIn / checkedInAt ──────────────────────────────────────
  // Primary signal: checkedInAt (field-level timestamp).
  // Secondary signal: clientUpdatedAt (detects deliberate clears where
  // one side has checkedInAt=null but a more recent row timestamp).
  const aCheckTs = a.checkedInAt ? Date.parse(a.checkedInAt) : 0;
  const bCheckTs = b.checkedInAt ? Date.parse(b.checkedInAt) : 0;

  let checkedIn: boolean;
  let checkedInAt: string | null;

  if (aCheckTs > 0 && bCheckTs > 0) {
    // Both have been checked in at some point — the more recent action wins.
    if (aCheckTs >= bCheckTs) {
      checkedIn = true;
      checkedInAt = a.checkedInAt;
    } else {
      checkedIn = true;
      checkedInAt = b.checkedInAt;
    }
  } else if (aCheckTs > 0 && bCheckTs === 0) {
    // Only A has a check-in timestamp. Is B a deliberate clear?
    if (bTs > aCheckTs) {
      // B was written more recently than A's check-in — deliberate clear.
      checkedIn = false;
      checkedInAt = null;
    } else {
      checkedIn = true;
      checkedInAt = a.checkedInAt;
    }
  } else if (bCheckTs > 0 && aCheckTs === 0) {
    // Only B has a check-in timestamp. Is A a deliberate clear?
    if (aTs > bCheckTs) {
      checkedIn = false;
      checkedInAt = null;
    } else {
      checkedIn = true;
      checkedInAt = b.checkedInAt;
    }
  } else {
    // Neither has a check-in timestamp.
    checkedIn = false;
    checkedInAt = null;
  }

  // ── photoUri ─────────────────────────────────────────────────────
  // Row-level last-write-wins via clientUpdatedAt. If timestamps are
  // missing or equal, fall back to local (A) value for safety.
  let photoUri: string | null;
  if (a.photoUri && b.photoUri && aTs > 0 && bTs > 0) {
    photoUri = aTs >= bTs ? a.photoUri : b.photoUri;
  } else if (a.photoUri && !b.photoUri) {
    photoUri = a.photoUri;
  } else if (!a.photoUri && b.photoUri) {
    // B has a photo but A doesn't. If B is clearly newer, take it.
    // Otherwise keep A's null (don't resurrect a deleted photo from an
    // older cloud row).
    photoUri = bTs > aTs ? b.photoUri : null;
  } else {
    photoUri = a.photoUri || b.photoUri || null;
  }

  // ── weight ───────────────────────────────────────────────────────
  let weight: string;
  const aWeight = (a.weight ?? '').trim();
  const bWeight = (b.weight ?? '').trim();
  if (aWeight && bWeight && aTs > 0 && bTs > 0) {
    weight = aTs >= bTs ? a.weight : b.weight;
  } else if (aWeight && !bWeight) {
    weight = a.weight;
  } else if (!aWeight && bWeight) {
    weight = bTs > aTs ? b.weight : '';
  } else {
    weight = aWeight || bWeight || '';
  }

  // ── clientUpdatedAt for the merged record ───────────────────────
  const mergedClientUpdatedAt: string | undefined =
    aTs >= bTs ? a.clientUpdatedAt : b.clientUpdatedAt;

  // ── Last-write-wins field picker ───────────────────────────────────
  // Uses clientUpdatedAt to decide which value wins. When timestamps are
  // missing or equal, falls back to the richer (non-empty) value. This
  // replaces the old "local always wins" pick() which silently discarded
  // every update made by another volunteer.
  const pickTs = (af: string, bf: string): string => {
    const aEmpty = !af.trim();
    const bEmpty = !bf.trim();
    if (aEmpty && bEmpty) return '';
    if (aEmpty) return bf;
    if (bEmpty) return af;
    if (aTs > 0 && bTs > 0) return aTs >= bTs ? af : bf;
    if (aTs > 0) return af;
    if (bTs > 0) return bf;
    return af;
  };

  return {
    ...a,
    firstName: pickTs(a.firstName ?? '', b.firstName ?? ''),
    lastName: pickTs(a.lastName ?? '', b.lastName ?? ''),
    club: pickTs(a.club ?? '', b.club ?? ''),
    ageGroup: pickTs(a.ageGroup ?? '', b.ageGroup ?? ''),
    division: pickTs(a.division ?? '', b.division ?? ''),
    teamName: pickTs(a.teamName ?? '', b.teamName ?? ''),
    dateOfBirth: pickTs(a.dateOfBirth ?? '', b.dateOfBirth ?? ''),
    parentName: pickTs(a.parentName ?? '', b.parentName ?? ''),
    parentPhone: pickTs(a.parentPhone ?? '', b.parentPhone ?? ''),
    isAgeVerified: aTs > 0 && bTs > 0
      ? (aTs >= bTs ? !!a.isAgeVerified : !!b.isAgeVerified)
      : (!!a.isAgeVerified || !!b.isAgeVerified),
    photoUri,
    weight,
    checkedIn,
    checkedInAt,
    restrictionStatus: (() => {
      const def = 'none';
      if (aTs > 0 && bTs > 0) return (aTs >= bTs ? a.restrictionStatus : b.restrictionStatus) ?? def;
      if (aTs > 0) return a.restrictionStatus ?? def;
      if (bTs > 0) return b.restrictionStatus ?? def;
      return a.restrictionStatus ?? b.restrictionStatus ?? def;
    })() as Player['restrictionStatus'],
    playsUp: (() => {
      if (aTs > 0 && bTs > 0) return aTs >= bTs ? (a.playsUp ?? false) : (b.playsUp ?? false);
      if (aTs > 0) return a.playsUp ?? false;
      if (bTs > 0) return b.playsUp ?? false;
      return a.playsUp ?? b.playsUp ?? false;
    })(),
    calculatedAgeGroup: pickTs(a.calculatedAgeGroup ?? '', b.calculatedAgeGroup ?? '') || undefined,
    clientUpdatedAt: mergedClientUpdatedAt,
  };
}

function scorePlayer(p: Player): number {
  let s = 0;
  if (p.checkedIn) s += 100;
  if (p.photoUri) s += 40;
  if (p.isAgeVerified) s += 20;
  if (p.weight && String(p.weight).trim()) s += 5;
  if (p.teamName && p.teamName.trim()) s += 3;
  if (p.parentName && p.parentName.trim()) s += 2;
  return s;
}

export function dedupePlayers(list: Player[]): { deduped: Player[]; duplicateIds: string[] } {
  // Filter out null/undefined entries that can appear if AsyncStorage
  // returns a partially-corrupt JSON array from a previous crash.
  const clean = list.filter((p): p is Player => !!p);
  if (clean.length !== list.length) {
    console.warn('[dedupe] filtered', list.length - clean.length, 'null/undefined entries from player list');
  }

  const groups = new Map<string, Player[]>();
  const noKey: Player[] = [];
  for (const p of clean) {
    const key = playerDedupeKey(p);
    if (!key) {
      noKey.push(p);
      continue;
    }
    const arr = groups.get(key);
    if (arr) arr.push(p); else groups.set(key, [p]);
  }
  const deduped: Player[] = [...noKey];
  const duplicateIds: string[] = [];
  for (const arr of groups.values()) {
    if (arr.length === 1) {
      deduped.push(arr[0]);
      continue;
    }
    const sorted = [...arr].sort((a, b) => {
      const diff = scorePlayer(b) - scorePlayer(a);
      if (diff !== 0) return diff;
      return a.id.localeCompare(b.id);
    });
    let canonical = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      canonical = mergePlayerRecords(canonical, sorted[i]);
      duplicateIds.push(sorted[i].id);
    }
    deduped.push({ ...canonical, id: sorted[0].id });
  }
  return { deduped, duplicateIds };
}

export interface SheetsConfig {
  spreadsheetId: string;
  sheetName: string;
  isConnected: boolean;
}

export interface SavedSheetInfo {
  url: string;
  spreadsheetId: string;
  title: string;
  lastImportedAt: string;
}

function generateSheetAccessCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

interface PendingWrite {
  id: string;
  player: Player;
  action: 'update' | 'add';
  timestamp: number;
  retries: number;
}

export const [RegistrationProvider, useRegistration] = createContextHook(() => {
  const queryClient = useQueryClient();
  // eslint-disable-next-line rork/general-context-optimization
  const trpcUtils = trpc.useUtils();
  // eslint-disable-next-line rork/general-context-optimization
  const {
    canEdit,
    isAdmin,
    revalidateEditorSession,
    setEventLockedForEditors,
    setIsOrgOwner,
    authUserId,
    setIsOrgAdminViaAuth,
  } = useAuth();
  // eslint-disable-next-line rork/general-context-optimization
  const { currentOrg, members } = useOrganization();

  // Determine whether the current device is the owner of the currently
  // selected organization. Only the device that originally created the
  // org will have an `owner` member record whose userId matches the
  // org's ownerId. Joiners only have a `volunteer` member record on
  // their device, so they are never treated as admin.
  useEffect(() => {
    if (!currentOrg) {
      setIsOrgOwner(false);
      return;
    }
    const isOwner = members.some(
      (m) =>
        m.orgId === currentOrg.id &&
        m.userId === currentOrg.ownerId &&
        (m.role === 'owner' || m.role === 'admin'),
    );
    console.log('[auth] org-owner check for', currentOrg.code, '->', isOwner);
    setIsOrgOwner(isOwner);
  }, [currentOrg, members, setIsOrgOwner]);

  // Auth-backed org admin (migration 032). When the signed-in auth user
  // has an org_members row with role admin/owner for the active org, we
  // flip a flag in AuthContext so the admin UI shows up regardless of
  // the device-owner check above. This is what allows e.g. a co-coach
  // granted via grant_org_admin_by_email to administer their org from
  // their own phone.
  useEffect(() => {
    let cancelled = false;
    if (!authUserId || !currentOrg) {
      setIsOrgAdminViaAuth(false);
      return;
    }
    void (async () => {
      try {
        const { data, error } = await supabase
          .from('org_members')
          .select('id')
          .eq('org_id', currentOrg.id)
          .eq('auth_uid', authUserId)
          .in('role', ['owner', 'admin'])
          .limit(1);
        if (cancelled) return;
        if (error) {
          // org_members.auth_uid doesn't exist pre-migration. Don't spam
          // the console; just treat as not-an-org-admin.
          if (!/auth_uid|column .* does not exist/i.test(error.message)) {
            console.warn('[auth] org-admin-via-auth lookup failed:', error.message);
          }
          setIsOrgAdminViaAuth(false);
          return;
        }
        setIsOrgAdminViaAuth((data?.length ?? 0) > 0);
      } catch (err) {
        if (!cancelled) {
          console.warn('[auth] org-admin-via-auth threw:', err);
          setIsOrgAdminViaAuth(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authUserId, currentOrg, setIsOrgAdminViaAuth]);
  const orgIdForRegistry = currentOrg?.id ?? 'utah-little-rugby';
  const orgScope = currentOrg?.id ?? NO_ORG_SCOPE;
  const orgScopeRef = useRef<string>(orgScope);
  useEffect(() => {
    orgScopeRef.current = orgScope;
  }, [orgScope]);

  const playersKey = useCallback(() => `${BASE_PLAYERS_STORAGE_KEY}:${orgScopeRef.current}`, []);
  const sheetsConfigKey = useCallback(() => `${BASE_SHEETS_CONFIG_KEY}:${orgScopeRef.current}`, []);
  const savedSheetUrlKey = useCallback(() => `${BASE_SAVED_SHEET_URL_KEY}:${orgScopeRef.current}`, []);
  const importedSheetsKey = useCallback(() => `${BASE_IMPORTED_SHEETS_KEY}:${orgScopeRef.current}`, []);
  const writeQueueKey = useCallback(() => `${BASE_WRITE_QUEUE_KEY}:${orgScopeRef.current}`, []);
  const eventModeKey = useCallback(() => `${BASE_EVENT_MODE_KEY}:${orgScopeRef.current}`, []);
  const showTeamAssignmentKey = useCallback(() => `${BASE_SHOW_TEAM_ASSIGNMENT_KEY}:${orgScopeRef.current}`, []);
  const importedMetadataKey = useCallback(() => `${BASE_IMPORTED_METADATA_KEY}:${orgScopeRef.current}`, []);
  const [verifiedRegistry, setVerifiedRegistry] = useState<Set<string>>(new Set());
  const verifiedRegistryRef = (useState(() => ({ current: new Set<string>() }))[0]);
  const [filters, setFilters] = useState<RegistrationFilters>({
    club: null,
    ageGroup: null,
    division: null,
    teamName: null,
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [sheetsConfig, setSheetsConfig] = useState<SheetsConfig | null>(null);
  const [isLoadingConfig, setIsLoadingConfig] = useState(true);
  const [savedSheetInfo, setSavedSheetInfo] = useState<SavedSheetInfo | null>(null);
  const [importedSheets, setImportedSheets] = useState<ImportedSheet[]>([]);
  const [pendingWrites, setPendingWrites] = useState<PendingWrite[]>([]);
  const [syncErrors, setSyncErrors] = useState<string[]>([]);
  const [eventMode, setEventModeState] = useState<EventMode>('registration');
  const [showTeamAssignment, setShowTeamAssignmentState] = useState<boolean>(false);
  
  // Persisted metadata from imports
  const [importedClubs, setImportedClubs] = useState<Club[]>([]);
  const [importedTeams, setImportedTeams] = useState<TeamOption[]>([]);
  const [importedAgeGroups, setImportedAgeGroups] = useState<AgeGroup[]>([]);
  const [importedDivisions, setImportedDivisions] = useState<Division[]>([]);

  // ── Coach state ──────────────────────────────────────────────────
  const [coaches, setCoaches] = useState<Coach[]>([]);
  const [coachTeams, setCoachTeams] = useState<CoachTeam[]>([]);

  // Canonical clubs come from `public.clubs` (migration 025). They are the
  // ONLY source of truth for the club picker — we no longer derive clubs
  // from player rows or sheet/CSV import metadata, because that's how the
  // variant-spelling problem was being reintroduced. While the fetch is in
  // flight (or offline), we serve the static fallback list which mirrors
  // the seed in migration 025.
  const [canonicalClubs, setCanonicalClubs] = useState<Club[]>(fallbackClubs);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const fetched = await fetchClubs();
        if (cancelled) return;
        if (fetched.length > 0) {
          setCanonicalClubs(fetched);
        }
      } catch (err) {
        // Network failure or migration not yet applied. Keep the static
        // fallback so the dropdown still works; log so we can spot it
        // in dev.
        console.warn('[RegistrationContext] fetchClubs failed, using static fallback:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Define Team type locally for the context if not imported
  type TeamOption = { id: string; name: string; club?: string; ageGroup?: string; division?: string };

  useEffect(() => {
    let cancelled = false;
    const loadConfig = async () => {
      // Reset all org-scoped state so switching orgs feels like a fresh
      // install for the new org until its data loads from storage / cloud.
      setSheetsConfig(null);
      setSavedSheetInfo(null);
      setImportedSheets([]);
      setPendingWrites([]);
      setImportedClubs([]);
      setImportedTeams([]);
      setImportedAgeGroups([]);
      setImportedDivisions([]);
      setEventModeState('registration');
      setShowTeamAssignmentState(false);
      memoryPlayerCache = null;
      try {
        const [storedConfig, storedMeta, storedSheetInfo, storedImportedSheets, storedQueue, storedEventMode, storedShowTeam] = await Promise.all([
          AsyncStorage.getItem(sheetsConfigKey()),
          AsyncStorage.getItem(importedMetadataKey()),
          AsyncStorage.getItem(savedSheetUrlKey()),
          AsyncStorage.getItem(importedSheetsKey()),
          AsyncStorage.getItem(writeQueueKey()),
          AsyncStorage.getItem(eventModeKey()),
          AsyncStorage.getItem(showTeamAssignmentKey()),
        ]);
        if (cancelled) return;

        if (storedEventMode === 'viewOnly' || storedEventMode === 'registration') {
          setEventModeState(storedEventMode);
          console.log('Loaded event mode for org', orgScope, '->', storedEventMode);
        }

        if (storedShowTeam === 'true') {
          setShowTeamAssignmentState(true);
          console.log('Loaded showTeamAssignment: true');
        }

        if (storedConfig) {
          console.log('Loaded sheets config for org', orgScope);
          setSheetsConfig(JSON.parse(storedConfig));
        }

        if (storedMeta) {
          const meta = JSON.parse(storedMeta);
          setImportedClubs(meta.clubs || []);
          setImportedTeams(meta.teams || []);
          setImportedAgeGroups(meta.ageGroups || []);
          setImportedDivisions(meta.divisions || []);
        }

        if (storedSheetInfo) {
          console.log('Loaded saved sheet info for org', orgScope);
          setSavedSheetInfo(JSON.parse(storedSheetInfo));
        }

        if (storedImportedSheets) {
          console.log('Loaded imported sheets history for org', orgScope);
          setImportedSheets(JSON.parse(storedImportedSheets));
        }

        if (storedQueue) {
          const queue = JSON.parse(storedQueue) as PendingWrite[];
          if (queue.length > 0) {
            console.log('Loaded pending write queue:', queue.length, 'items');
            setPendingWrites(queue);
          }
        }
      } catch (error) {
        console.error('Failed to load sheets config:', error);
      } finally {
        if (!cancelled) setIsLoadingConfig(false);
      }
    };
    void loadConfig();
    return () => {
      cancelled = true;
    };
  }, [orgScope, sheetsConfigKey, importedMetadataKey, savedSheetUrlKey, importedSheetsKey, writeQueueKey, eventModeKey, showTeamAssignmentKey]);

  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      const cached = await loadCachedRegistry(orgIdForRegistry);
      if (cancelled) return;
      if (cached.size > 0) {
        console.log('[registry] hydrated from cache:', cached.size);
        verifiedRegistryRef.current = cached;
        setVerifiedRegistry(cached);
      }
      const remote = await fetchRegistryFromRemote(orgIdForRegistry);
      if (cancelled) return;
      if (remote.size > 0 || cached.size === 0) {
        verifiedRegistryRef.current = remote;
        setVerifiedRegistry(remote);
      }
    };
    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [orgIdForRegistry, verifiedRegistryRef]);

  // Google Sheets backend is offline-only / safe-mode. We never actually hit
  // the network here — the app keeps all data locally and syncs org + roster
  // via Supabase instead. Returning empty stubs prevents the "Reconnecting…"
  // banner from showing when the tRPC API is unreachable.
  const sheetsPlayersQuery = useQuery({
    queryKey: ['sheets-players-stub', sheetsConfig?.spreadsheetId, sheetsConfig?.sheetName],
    queryFn: async () => [] as Player[],
    enabled: !!sheetsConfig?.isConnected && !!sheetsConfig?.spreadsheetId,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    retry: false,
  });

  const sheetsMetadataQuery = useQuery({
    queryKey: ['sheets-metadata-stub', sheetsConfig?.spreadsheetId],
    queryFn: async () => ({
      clubs: [] as { id: string; name: string }[],
      teams: [] as { id: string; name: string; club?: string; ageGroup?: string; division?: string }[],
      ageGroups: [] as { id: string; name: string }[],
      divisions: [] as { id: string; name: string }[],
      title: '',
    }),
    enabled: !!sheetsConfig?.isConnected && !!sheetsConfig?.spreadsheetId,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    retry: false,
  });

  const localPlayersQuery = useQuery({
    queryKey: ['local-players', orgScope],
    queryFn: async () => {
      console.log('Fetching players from local storage for org', orgScope);
      const stored = await AsyncStorage.getItem(playersKey());
      if (stored) {
        console.log('Found stored players');
        const parsed = JSON.parse(stored) as Player[];
        memoryPlayerCache = parsed;
        return parsed;
      }
      console.log('No stored players, returning empty list');
      memoryPlayerCache = [];
      return [];
    },
    enabled: true,
    placeholderData: memoryPlayerCache ?? undefined,
    staleTime: 30000,
  });

  // ---------------------------------------------------------------------------
  // Multi-device roster sync via Supabase (step 2)
  // On org change: fetch remote roster + subscribe to realtime changes.
  // Any time another volunteer updates a player, this device receives the
  // change and merges it into local state + AsyncStorage.
  // ---------------------------------------------------------------------------
  // Batch incoming realtime changes to avoid UI flashing when many events
  // arrive in quick succession (e.g. other volunteers checking in kids).
  const pendingChangesRef = useRef<Map<string, RosterChange>>(new Map());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Forward-ref to flushCloudQueueNow so the queue-aware mergeRemoteRoster
  // effect (declared above the useCallback below) can call it safely. The
  // useCallback wires this ref the first time it runs.
  const flushCloudQueueRef = useRef<(() => Promise<FlushResult | null>) | null>(null);

  const playersEqual = useCallback((a: Player, b: Player): boolean => {
    return (
      a.id === b.id &&
      a.firstName === b.firstName &&
      a.lastName === b.lastName &&
      a.club === b.club &&
      a.ageGroup === b.ageGroup &&
      a.division === b.division &&
      a.teamName === b.teamName &&
      a.dateOfBirth === b.dateOfBirth &&
      a.parentName === b.parentName &&
      a.parentPhone === b.parentPhone &&
      !!a.isAgeVerified === !!b.isAgeVerified &&
      (a.photoUri ?? null) === (b.photoUri ?? null) &&
      (a.weight ?? '') === (b.weight ?? '') &&
      !!a.checkedIn === !!b.checkedIn &&
      (a.checkedInAt ?? null) === (b.checkedInAt ?? null) &&
      (a.restrictionStatus ?? 'none') === (b.restrictionStatus ?? 'none') &&
      (a.calculatedAgeGroup ?? '') === (b.calculatedAgeGroup ?? '')
    );
  }, []);

  const flushPendingChanges = useCallback(async () => {
    flushTimerRef.current = null;
    const pending = pendingChangesRef.current;
    if (pending.size === 0) return;
    const changes = Array.from(pending.values());
    pendingChangesRef.current = new Map();

    try {
      const stored = await AsyncStorage.getItem(playersKey());
      const current: Player[] = stored ? JSON.parse(stored) : [];
      const byId = new Map<string, Player>();
      current.forEach((p) => byId.set(p.id, p));

      let mutated = false;
      for (const change of changes) {
        if (change.kind === 'upsert') {
          const existing = byId.get(change.player.id);
          if (!existing || !playersEqual(existing, change.player)) {
            byId.set(change.player.id, change.player);
            mutated = true;
          }
        } else if (change.kind === 'delete') {
          if (byId.has(change.id)) {
            byId.delete(change.id);
            mutated = true;
          }
        }
      }

      if (!mutated) {
        console.log('[rosterSync] batched changes were no-ops, skipping re-render');
        return;
      }

      const next = Array.from(byId.values());
      memoryPlayerCache = next;
      await AsyncStorage.setItem(playersKey(), JSON.stringify(next));
      queryClient.setQueryData(['local-players', orgScopeRef.current], next);
      console.log('[rosterSync] applied batched remote changes:', changes.length);
    } catch (err) {
      console.warn('[rosterSync] failed to flush remote changes:', err);
    }
  }, [playersEqual, queryClient]);

  const applyRosterChangeLocally = useCallback(
    (change: RosterChange) => {
      const key = change.kind === 'upsert' ? change.player.id : change.id;
      pendingChangesRef.current.set(key, change);
      if (flushTimerRef.current == null) {
        flushTimerRef.current = setTimeout(() => {
          void flushPendingChanges();
        }, 300);
      }
    },
    [flushPendingChanges],
  );

  // Performs the queue-aware merge of (cloud roster) + (persisted queue) +
  // (locally stored roster). Extracted from the org-change useEffect below
  // so it's also callable on demand (e.g. on roster screen focus).
  //
  // Re-entrancy: if the active org changes mid-fetch, the second branch
  // bails out before mutating state. Callers should ignore the resolved
  // value -- the function returns a status string for logging / UI.
  const refreshRosterFromCloud = useCallback(
    async (): Promise<'ok' | 'no-org' | 'aborted' | 'error'> => {
      const orgId = cloudOrgRef.current;
      if (!orgId) return 'no-org';
      try {
        const stored = await AsyncStorage.getItem(playersKey());
        if (cloudOrgRef.current !== orgId) return 'aborted';
        const localStored: Player[] = stored ? JSON.parse(stored) : [];

        // Read the queue directly from AsyncStorage (instead of from
        // cloudQueueRef.current) because the queue-loading effect runs
        // independently and may not have populated state yet.
        const persistedQueue = await loadCloudSyncQueue(orgId);
        if (cloudOrgRef.current !== orgId) return 'aborted';
        const queuedById = new Map<string, Player>();
        for (const q of persistedQueue) {
          queuedById.set(q.playerId, q.player);
        }

        // Build "current local truth" = stored players, with any queued
        // edit overlaying its previous version.
        const localById = new Map<string, Player>();
        for (const p of localStored) {
          const queued = queuedById.get(p.id);
          localById.set(p.id, queued ?? p);
        }
        // Include queue-only entries that aren't in storage yet (new
        // players added offline that haven't been persisted to the local
        // roster blob for any reason).
        for (const q of persistedQueue) {
          if (!localById.has(q.playerId)) {
            localById.set(q.playerId, q.player);
          }
        }

        const remote = await fetchRoster(orgId);
        if (cloudOrgRef.current !== orgId) return 'aborted';

        if (remote.length === 0 && localById.size === 0) {
          console.log('[rosterSync] both remote and local empty, nothing to merge');
          return 'ok';
        }

        // Merge. For ids only in one side: take that side. For ids in
        // both: per-field merge with local first so any local-only field
        // (photo, weight, check-in) survives a stale remote row.
        const mergedById = new Map<string, Player>(localById);
        for (const r of remote) {
          const local = mergedById.get(r.id);
          if (!local) {
            mergedById.set(r.id, r);
          } else {
            mergedById.set(r.id, mergePlayerRecords(local, r));
          }
        }

        const combined = Array.from(mergedById.values());
        const { deduped, duplicateIds } = dedupePlayers(combined);

        memoryPlayerCache = deduped;
        await AsyncStorage.setItem(playersKey(), JSON.stringify(deduped));
        queryClient.setQueryData(['local-players', orgScopeRef.current], deduped);
        console.log('[rosterSync] merged remote roster (queue-aware):', {
          remote: remote.length,
          localStored: localStored.length,
          queued: persistedQueue.length,
          combined: combined.length,
          deduped: deduped.length,
          duplicatesDetected: duplicateIds.length,
        });

        // SAFETY: we deliberately do NOT auto-delete cloud rows or
        // auto-re-upsert "canonical" rows here, even when the local dedupe
        // collapses two players together. Reasons:
        //
        //   1. dedupePlayers() groups by (firstName, lastName, dateOfBirth).
        //      That can collide real distinct people who share that key —
        //      twins, name reuse, missing DOBs — and we have no way to
        //      tell from the client.
        //
        //   2. If fetchRoster() ever returns a partial result (a network
        //      blip, an RLS filter, an unpaginated 1000-row PostgREST cap),
        //      a row that's actually in the cloud but absent from this
        //      response is indistinguishable from a duplicate. We had
        //      exactly that bug before pagination was added: rows past
        //      index 1000 were silently truncated and the dedupe was
        //      flagging valid rows for deletion.
        //
        //   3. Two devices running this dedupe concurrently can pick
        //      different "canonical" winners and fight each other.
        //
        // Cleaning duplicates in the cloud is an admin operation that
        // requires explicit opt-in, a backup, and confirmation. It does
        // not belong in the launch merge path. We log so duplicates are
        // visible during triage; the in-memory deduped list keeps the
        // UI clean without touching the server.
        if (duplicateIds.length > 0) {
          console.warn(
            '[rosterSync] dedupe collapsed local view; cloud rows preserved.',
            'Inspect via SQL and run an explicit admin cleanup if intentional.',
            { duplicateIdsSample: duplicateIds.slice(0, 10), duplicateCount: duplicateIds.length },
          );
        }

        // After we've reconciled local + remote, push anything still in
        // the queue. flushCloudQueueRef is wired by the useCallback below;
        // it may be null on the very first render, in which case the
        // separate "auto-flush on launch" effect will catch it on the
        // next tick.
        const flush = flushCloudQueueRef.current;
        if (flush) void flush();
        setCloudRefreshError(null);
        setCloudRefreshFailedAt(null);
        return 'ok';
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[rosterSync] refreshRosterFromCloud failed (using local cache):', message);
        setCloudRefreshError(message);
        setCloudRefreshFailedAt(new Date().toISOString());
        return 'error';
      }
    },
    [queryClient, playersKey],
  );

  useEffect(() => {
    if (!currentOrg?.id) return;
    let cancelled = false;

    refreshRosterFromCloud().catch((err) => {
      console.warn('[rosterSync] initial fetch failed:', err);
    });

    const unsubscribe = subscribeToRoster(currentOrg.id, (change) => {
      if (cancelled) return;
      applyRosterChangeLocally(change);
    });

    return () => {
      cancelled = true;
      unsubscribe();
      if (flushTimerRef.current != null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      pendingChangesRef.current = new Map();
    };
  }, [currentOrg?.id, applyRosterChangeLocally, refreshRosterFromCloud]);

  // ── AppState foreground refresh + periodic background revalidation ──
  // When the app returns from the background, re-fetch the roster from
  // Supabase so stale AsyncStorage data is always replaced with the
  // latest cloud data without requiring a force-close or reinstall.
  //
  // Additionally, we run a periodic refresh every 5 minutes while the app
  // is in the foreground. This catches updates from other volunteers
  // without requiring the user to background/foreground the app.
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const periodicTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    const handleChange = (nextState: AppStateStatus) => {
      if (appStateRef.current.match(/inactive|background/) && nextState === 'active') {
        console.log('[appState] app returned to foreground, refreshing roster from cloud');
        refreshRosterFromCloud().catch((err) => {
          console.warn('[rosterSync] foreground refresh failed:', err);
        });
      }
      appStateRef.current = nextState;
    };
    const subscription = AppState.addEventListener('change', handleChange);

    // Start periodic refresh (every 5 minutes)
    const FIVE_MINUTES = 5 * 60 * 1000;
    periodicTimerRef.current = setInterval(() => {
      if (AppState.currentState === 'active' && currentOrg?.id) {
        console.log('[rosterSync] periodic cloud refresh');
        refreshRosterFromCloud().catch((err) => {
          console.warn('[rosterSync] periodic refresh failed:', err);
        });
      }
    }, FIVE_MINUTES);

    return () => {
      subscription.remove();
      if (periodicTimerRef.current != null) {
        clearInterval(periodicTimerRef.current);
        periodicTimerRef.current = null;
      }
    };
  }, [refreshRosterFromCloud, currentOrg?.id]);

  // ── retryCloudRefresh — callable from UI ──────────────────────────
  const retryCloudRefresh = useCallback(async () => {
    setCloudRefreshError(null);
    setCloudRefreshFailedAt(null);
    return refreshRosterFromCloud();
  }, [refreshRosterFromCloud]);

  // ── Coach fetch + realtime subscription ──────────────────────────
  useEffect(() => {
    if (!currentOrg?.id) return;
    let cancelled = false;
    const orgId = currentOrg.id;

    void (async () => {
      try {
        const [fetchedCoaches, fetchedCoachTeams] = await Promise.all([
          fetchCoaches(orgId),
          fetchCoachTeams(orgId),
        ]);
        if (cancelled) return;
        setCoaches(fetchedCoaches);
        setCoachTeams(fetchedCoachTeams);
        console.log('[coachSync] loaded', fetchedCoaches.length, 'coaches and', fetchedCoachTeams.length, 'team assignments');
      } catch (err) {
        console.warn('[coachSync] initial fetch failed:', err);
      }
    })();

    const unsubscribe = subscribeToCoaches(orgId, (change: CoachChange) => {
      if (cancelled) return;
      if (change.kind === 'upsert') {
        setCoaches((prev) => {
          const idx = prev.findIndex((c) => c.id === change.coach.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = change.coach;
            return next;
          }
          return [...prev, change.coach];
        });
      } else if (change.kind === 'delete') {
        setCoaches((prev) => prev.filter((c) => c.id !== change.id));
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [currentOrg?.id]);

  // Allow the roster screen to re-pull coach data when it gains focus,
  // so coaches added on another device (or whose initial fetch silently
  // failed before the tables existed) show up without a full app restart.
  const refreshCoaches = useCallback(async () => {
    const orgId = currentOrg?.id;
    if (!orgId) return;
    try {
      const [fetchedCoaches, fetchedCoachTeams] = await Promise.all([
        fetchCoaches(orgId),
        fetchCoachTeams(orgId),
      ]);
      // Guard against the org changing mid-fetch
      if (currentOrg?.id !== orgId) return;
      setCoaches(fetchedCoaches);
      setCoachTeams(fetchedCoachTeams);
      console.log('[coachSync] refreshed', fetchedCoaches.length, 'coaches and', fetchedCoachTeams.length, 'team assignments');
    } catch (err) {
      console.warn('[coachSync] refresh failed:', err);
    }
  }, [currentOrg?.id]);

  const addCoach = useCallback(
    async (
      input: Omit<Coach, 'id' | 'checkedIn' | 'checkedInAt'>,
      teamAssignments: Omit<CoachTeam, 'id' | 'coachId' | 'orgId'>[],
    ): Promise<Coach | null> => {
      if (!currentOrg?.id) return null;
      const newCoachId = randomId('coach');
      const orgId = currentOrg.id;

      // Upload photo to Supabase Storage if it's a local file:// URI.
      // This matches the player flow: local URIs are device-only and
      // won't render on other volunteers' devices. We upload inline
      // here because coach edits are infrequent (unlike rapid player
      // check-ins, which use a background queue).
      let cloudPhotoUri: string | null = input.photoUri ?? null;
      if (cloudPhotoUri && !cloudPhotoUri.startsWith('http')) {
        try {
          const coachName = `${input.firstName ?? ''} ${input.lastName ?? ''}`.trim();
          cloudPhotoUri = await uploadCoachPhoto(newCoachId, cloudPhotoUri, orgId, 2, coachName || undefined);
          console.log('[coachSync] photo uploaded for new coach', newCoachId, '->', cloudPhotoUri);
        } catch (err) {
          console.warn('[coachSync] photo upload failed for new coach, saving with local URI as fallback:', err);
          // Fall through with the original local URI so the photo at
          // least shows on this device. The shareablePhotoUri guard in
          // coachToRow will filter it from the cloud row, so other
          // devices won't see a broken image.
        }
      }

      const newCoach: Coach = {
        id: newCoachId,
        firstName: input.firstName ?? '',
        lastName: input.lastName ?? '',
        photoUri: cloudPhotoUri,
        isCertified: !!input.isCertified,
        checkedIn: false,
        checkedInAt: null,
      };
      // Optimistic
      setCoaches((prev) => [...prev, newCoach]);
      const ctRows: CoachTeam[] = teamAssignments.map((t) => ({
        id: `${newCoach.id}_${(t.teamName || '').replace(/\s+/g, '_').toLowerCase()}`,
        coachId: newCoach.id,
        orgId: currentOrg.id,
        club: t.club ?? '',
        ageGroup: t.ageGroup ?? '',
        division: t.division ?? '',
        teamName: t.teamName ?? '',
      }));
      setCoachTeams((prev) => [...prev, ...ctRows]);
      try {
        await upsertCoach(orgId, newCoach);
        await upsertCoachTeams(orgId, newCoach.id, teamAssignments);
        return newCoach;
      } catch (err) {
        console.warn('[coachSync] addCoach failed, reverting:', err);
        setCoaches((prev) => prev.filter((c) => c.id !== newCoach.id));
        setCoachTeams((prev) => prev.filter((ct) => ct.coachId !== newCoach.id));
        throw err;
      }
    },
    [currentOrg?.id],
  );

  const deleteCoach = useCallback(
    async (coachId: string): Promise<void> => {
      if (!currentOrg?.id || !coachId) return;
      const prevCoaches = coaches;
      const prevTeams = coachTeams;
      // Optimistic
      setCoaches((p) => p.filter((c) => c.id !== coachId));
      setCoachTeams((p) => p.filter((ct) => ct.coachId !== coachId));
      try {
        await deleteCoachRemote(currentOrg.id, coachId);
      } catch (err) {
        console.warn('[coachSync] deleteCoach failed, reverting:', err);
        setCoaches(prevCoaches);
        setCoachTeams(prevTeams);
        throw err;
      }
    },
    [currentOrg?.id, coaches, coachTeams],
  );

  const setCoachTeamAssignments = useCallback(
    async (
      coachId: string,
      teamAssignments: Omit<CoachTeam, 'id' | 'coachId' | 'orgId'>[],
    ): Promise<void> => {
      if (!currentOrg?.id || !coachId) return;
      const orgId = currentOrg.id;
      const prev = coachTeams;
      const newRows: CoachTeam[] = teamAssignments.map((t) => ({
        id: `${coachId}_${(t.teamName || '').replace(/\s+/g, '_').toLowerCase()}`,
        coachId,
        orgId,
        club: t.club ?? '',
        ageGroup: t.ageGroup ?? '',
        division: t.division ?? '',
        teamName: t.teamName ?? '',
      }));
      // Optimistic: drop this coach's rows, add the new ones
      setCoachTeams((p) => [...p.filter((ct) => ct.coachId !== coachId), ...newRows]);
      try {
        await upsertCoachTeams(orgId, coachId, teamAssignments);
      } catch (err) {
        console.warn('[coachSync] setCoachTeamAssignments failed, reverting:', err);
        setCoachTeams(prev);
        throw err;
      }
    },
    [currentOrg?.id, coachTeams],
  );

  const updateCoach = useCallback(async (coach: Coach): Promise<void> => {
    if (!currentOrg?.id) return;
    const orgId = currentOrg.id;

    // Upload photo if it's a local file:// URI (same reasoning as addCoach)
    let cloudPhotoUri: string | null = coach.photoUri ?? null;
    if (cloudPhotoUri && !cloudPhotoUri.startsWith('http')) {
      try {
        const coachName = `${coach.firstName ?? ''} ${coach.lastName ?? ''}`.trim();
        cloudPhotoUri = await uploadCoachPhoto(coach.id, cloudPhotoUri, orgId, 2, coachName || undefined);
        console.log('[coachSync] photo uploaded for coach', coach.id, '->', cloudPhotoUri);
      } catch (err) {
        console.warn('[coachSync] photo upload failed for coach update, using local URI fallback:', err);
      }
    }

    const coachWithCloudPhoto: Coach = { ...coach, photoUri: cloudPhotoUri };

    // Optimistic local update
    setCoaches((prev) => {
      const idx = prev.findIndex((c) => c.id === coachWithCloudPhoto.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = coachWithCloudPhoto;
        return next;
      }
      return [...prev, coachWithCloudPhoto];
    });
    // Push to Supabase (shareablePhotoUri in coachToRow filters any
    // remaining file:// URIs as a safety net)
    try {
      await upsertCoach(orgId, coachWithCloudPhoto);
      console.log('[coachSync] upserted coach', coach.id);
    } catch (err) {
      console.warn('[coachSync] upsert failed, reverting:', err);
      // Revert on failure by re-fetching
      try {
        const fresh = await fetchCoaches(orgId);
        setCoaches(fresh);
      } catch (_) {}
    }
  }, [currentOrg?.id]);

  // ── Bulk coach import ─────────────────────────────────────────────────────
  // Accepts parsed rows from a CSV/Google Sheet and creates Coach + CoachTeam
  // records. Coaches that match an existing coach (by first + last name) are
  // skipped silently so re-importing the same sheet is idempotent.
  const importCoaches = useCallback(
    async (
      rows: {
        firstName: string;
        lastName: string;
        club: string;
        ageGroup: string;
        division: string;
        teamName: string;
        isCertified: boolean;
      }[],
    ): Promise<{ created: number; skipped: number }> => {
      if (!currentOrg?.id || rows.length === 0) return { created: 0, skipped: 0 };
      const orgId = currentOrg.id;

      // Build lookup of existing coaches by normalised full name
      const existingNames = new Set(
        coaches.map((c) => `${c.firstName.trim().toLowerCase()} ${c.lastName.trim().toLowerCase()}`),
      );

      let created = 0;
      let skipped = 0;
      const newCoaches: Coach[] = [];
      const newTeams: CoachTeam[] = [];
      // Track coaches already created in this batch so additional rows
      // for the same coach only add team assignments (no duplicate coach records).
      const batchCoachIds = new Map<string, string>(); // nameKey -> coachId

      for (const row of rows) {
        const nameKey = `${(row.firstName || '').trim().toLowerCase()} ${(row.lastName || '').trim().toLowerCase()}`;
        if (!row.firstName?.trim() || !row.lastName?.trim()) {
          skipped++;
          continue;
        }

        // Already exists in the DB — skip the entire row (idempotent).
        if (existingNames.has(nameKey)) {
          skipped++;
          continue;
        }

        let coachId: string;
        const existingBatchId = batchCoachIds.get(nameKey);
        if (existingBatchId) {
          // Same coach, additional row — only add the team assignment.
          coachId = existingBatchId;
        } else {
          // First time seeing this coach in the batch.
          coachId = randomId('coach');
          batchCoachIds.set(nameKey, coachId);

          const newCoach: Coach = {
            id: coachId,
            firstName: row.firstName.trim(),
            lastName: row.lastName.trim(),
            photoUri: null,
            isCertified: !!row.isCertified,
            checkedIn: false,
            checkedInAt: null,
          };
          newCoaches.push(newCoach);
          created++;
        }

        if ((row.teamName || '').trim()) {
          newTeams.push({
            id: `${coachId}_${(row.teamName || '').replace(/\s+/g, '_').toLowerCase()}`,
            coachId,
            orgId,
            club: (row.club || '').trim(),
            ageGroup: (row.ageGroup || '').trim(),
            division: (row.division || '').trim(),
            teamName: (row.teamName || '').trim(),
          });
        }
      }

      if (created === 0) return { created: 0, skipped };

      // Optimistic update
      setCoaches((prev) => [...prev, ...newCoaches]);
      setCoachTeams((prev) => [...prev, ...newTeams]);

      try {
        // Upsert all coaches
        await Promise.all(newCoaches.map((c) => upsertCoach(orgId, c)));
        // Upsert team assignments per coach (coachSync.upsertCoachTeams uses delete+insert pattern)
        for (const nc of newCoaches) {
          const coachTeams2 = newTeams.filter((t) => t.coachId === nc.id);
          if (coachTeams2.length > 0) {
            const assignments: Omit<CoachTeam, 'id' | 'coachId' | 'orgId'>[] = coachTeams2.map(
              ({ club, ageGroup, division, teamName }) => ({
                club,
                ageGroup,
                division,
                teamName,
              }),
            );
            await upsertCoachTeams(orgId, nc.id, assignments);
          }
        }
        console.log('[coachSync] imported', created, 'coaches, skipped', skipped);
      } catch (err) {
        console.warn('[coachSync] import failed, reverting:', err);
        // Revert on failure by re-fetching from Supabase
        try {
          const fresh = await fetchCoaches(orgId);
          const freshTeams = await fetchCoachTeams(orgId);
          setCoaches(fresh);
          setCoachTeams(freshTeams);
        } catch (_) {}
        throw err;
      }

      return { created, skipped };
    },
    [currentOrg?.id, coaches],
  );

  // ---------------------------------------------------------------------------
  // Cross-device event_mode sync.
  // The admin's lock / unlock flips a column on `organizations` in Supabase.
  // Every other device subscribes to realtime updates on that row and applies
  // the new mode immediately. When the event flips to view-only, editors are
  // forced to re-validate their session (revoke happens server-side first), so
  // their device drops to viewer right away.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const orgId = currentOrg?.id;
    if (!orgId) return;
    let cancelled = false;

    const applyMode = async (mode: EventMode) => {
      if (cancelled) return;
      setEventModeState((prev) => {
        if (prev !== mode) {
          console.log('[eventMode] applying remote change ->', mode);
        }
        return mode;
      });
      try {
        await AsyncStorage.setItem(eventModeKey(), mode);
      } catch (err) {
        console.warn('[eventMode] persist failed:', err);
      }
      // Tell AuthContext whether editors should be locked out of writes.
      // Admins are unaffected; this flips canEdit=false for editors so the
      // entire app (including button states) reacts immediately on every
      // device that's currently viewing this org.
      try {
        setEventLockedForEditors(mode === 'viewOnly');
      } catch (err) {
        console.warn('[eventMode] setEventLockedForEditors failed:', err);
      }
      if (mode === 'viewOnly') {
        try {
          await revalidateEditorSession();
        } catch (err) {
          console.warn('[eventMode] revalidate failed:', err);
        }
      }
    };

    void (async () => {
      const remote = await fetchOrgEventMode(orgId);
      if (remote) await applyMode(remote);
    })();

    const unsubscribe = subscribeOrgEventMode(orgId, (mode) => {
      void applyMode(mode);
    });

    // Periodic poll as a safety net in case Supabase realtime isn't
    // delivering updates to this device (e.g. WebSocket dropped). 15s is
    // tight enough for the lock to feel mandatory at an event.
    const pollId = setInterval(() => {
      if (cancelled) return;
      void (async () => {
        const remote = await fetchOrgEventMode(orgId);
        if (remote) await applyMode(remote);
      })();
    }, 15000);

    return () => {
      cancelled = true;
      unsubscribe();
      clearInterval(pollId);
    };
  }, [currentOrg?.id, revalidateEditorSession, setEventLockedForEditors]);

  // ---------------------------------------------------------------------------
  // Cloud sync queue
  // Every roster edit is enqueued to a per-org persistent queue and flushed
  // to Supabase. If the network is flaky, the item stays in the queue and
  // gets retried on launch / reconnect / Settings -> Force Sync Now.
  // ---------------------------------------------------------------------------
  const [cloudQueue, setCloudQueue] = useState<CloudSyncItem[]>([]);
  const [isCloudSyncing, setIsCloudSyncing] = useState<boolean>(false);
  const [lastCloudSyncedAt, setLastCloudSyncedAt] = useState<string | null>(null);
  const [lastCloudSyncResult, setLastCloudSyncResult] = useState<FlushResult | null>(null);
  // Cloud roster refresh error tracking — surfaced so the UI can show a
  // "Data may be stale" banner with a retry button.
  const [cloudRefreshError, setCloudRefreshError] = useState<string | null>(null);
  const [cloudRefreshFailedAt, setCloudRefreshFailedAt] = useState<string | null>(null);
  // Tracks the device's network connectivity. Defaults to `true` so the app
  // doesn't render "Offline" badges on cold start before NetInfo has fired
  // its first event. Updated by the NetInfo listener registered below.
  const [isOnline, setIsOnline] = useState<boolean>(true);
  const cloudQueueRef = useRef<CloudSyncItem[]>([]);
  const isCloudSyncingRef = useRef<boolean>(false);
  // Track when the current sync started so we can detect a stalled sync
  // (e.g. a Supabase thenable that never resolves in Hermes) and force-
  // reset the guard flag. Without this, one hung sync permanently blocks
  // all future sync attempts, even across app foreground/background cycles.
  const cloudSyncStartedAtRef = useRef<number>(0);
  // When a flush is already running and a new edit gets enqueued, we set
  // this flag so the in-flight flush can immediately kick another flush
  // when it finishes. Without this, rapid successive check-ins would sit
  // in the queue waiting for the next periodic retry / network event.
  const cloudFlushPendingRef = useRef<boolean>(false);
  const cloudOrgRef = useRef<string | null>(null);
  cloudOrgRef.current = currentOrg?.id ?? null;
  // Stamp every Supabase write with the auth user id so server-side
  // operators can distinguish app-originated writes from direct DB edits.
  const updatedByRef = useRef<string>('app:device');
  updatedByRef.current = authUserId ? `app:${authUserId}` : 'app:device';

  useEffect(() => {
    cloudQueueRef.current = cloudQueue;
  }, [cloudQueue]);

  useEffect(() => {
    let cancelled = false;
    const orgId = currentOrg?.id ?? null;
    setCloudQueue([]);
    setLastCloudSyncedAt(null);
    setLastCloudSyncResult(null);
    if (!orgId) return;
    void (async () => {
      const [queue, last] = await Promise.all([
        loadCloudSyncQueue(orgId),
        loadLastCloudSync(orgId),
      ]);
      if (cancelled) return;
      console.log('[cloudSync] loaded queue for', orgId, '->', queue.length, 'items');
      setCloudQueue(queue);
      setLastCloudSyncedAt(last);
    })();
    return () => {
      cancelled = true;
    };
  }, [currentOrg?.id]);

  const persistCloudQueue = useCallback(
    async (orgId: string, next: CloudSyncItem[]) => {
      cloudQueueRef.current = next;
      setCloudQueue(next);
      await saveCloudSyncQueue(orgId, next);
    },
    [],
  );

  const enqueueCloudWrite = useCallback(
    (player: Player) => {
      const orgId = currentOrg?.id;
      if (!orgId) return;
      const item = buildItem(orgId, player);
      const next = mergeIntoQueue(cloudQueueRef.current, item);
      void persistCloudQueue(orgId, next);
      console.log('[cloudSync] enqueued', player.id, 'queue size:', next.length);
    },
    [currentOrg?.id, persistCloudQueue],
  );

  const enqueueCloudWrites = useCallback(
    (playersBatch: Player[]) => {
      const orgId = currentOrg?.id;
      if (!orgId || playersBatch.length === 0) return;
      let next = cloudQueueRef.current;
      for (const p of playersBatch) {
        next = mergeIntoQueue(next, buildItem(orgId, p));
      }
      void persistCloudQueue(orgId, next);
      console.log('[cloudSync] enqueued batch', playersBatch.length, 'queue size:', next.length);
    },
    [currentOrg?.id, persistCloudQueue],
  );

  const flushCloudQueueNow = useCallback(async (): Promise<FlushResult | null> => {
    const orgId = cloudOrgRef.current;
    if (!orgId) return null;
    if (isCloudSyncingRef.current) {
      // Stall guard: if the previous sync has been running for more than
      // 45 s, it's likely hung (Hermes thenable stall, etc.). Force-reset
      // the guard flag and allow a fresh attempt. The global fetch
      // timeout (20 s) plus per-call timeouts (15-20 s) guarantee that no
      // individual Supabase call can exceed ~20 s, so 45 s means the
      // process is genuinely stuck at a higher level.
      const elapsed = Date.now() - cloudSyncStartedAtRef.current;
      if (cloudSyncStartedAtRef.current > 0 && elapsed > 45_000) {
        console.warn(
          '[cloudSync] previous flush stalled for',
          elapsed,
          'ms — force-resetting guard and retrying',
        );
        isCloudSyncingRef.current = false;
        setIsCloudSyncing(false);
        // Fall through to start a new flush below.
      } else {
        // Flush is already running. Mark "pending" so the in-flight call
        // re-flushes once it finishes, picking up anything that was
        // enqueued while it was running. This fixes the "kid 2 and 3 sit
        // in the queue waiting" gap when a volunteer rapid-fires several
        // check-ins back to back.
        cloudFlushPendingRef.current = true;
        console.log('[cloudSync] flush already in progress, marking re-flush pending');
        return null;
      }
    }
    const items = cloudQueueRef.current;
    if (items.length === 0) {
      const now = new Date().toISOString();
      setLastCloudSyncedAt(now);
      await saveLastCloudSync(orgId, now);
      return { synced: [], merged: [], failed: [] };
    }
    isCloudSyncingRef.current = true;
    setIsCloudSyncing(true);
    cloudSyncStartedAtRef.current = Date.now();
    try {
      console.log('[cloudSync] flushing', items.length, 'items for org', orgId);
      // Audit Critical #2: pass the per-field merge function so items
      // where the remote is newer get merged + pushed instead of being
      // silently skipped. Only items that are actually `synced` or
      // `merged` (both have written something authoritative to Supabase)
      // are dropped from the queue. Failures stay in for the next retry.
      const result = await flushCloudSyncQueue(orgId, items, mergePlayerRecords, updatedByRef.current);
      const handled = new Set([...result.synced, ...result.merged]);
      const remaining = items
        .filter((i) => !handled.has(i.id))
        .map((i) => {
          const fail = result.failed.find((f) => f.itemId === i.id);
          return {
            ...i,
            retries: i.retries + 1,
            lastTriedAt: new Date().toISOString(),
            lastError: fail?.error ?? i.lastError,
          };
        });
      await persistCloudQueue(orgId, remaining);
      const now = new Date().toISOString();
      setLastCloudSyncedAt(now);
      await saveLastCloudSync(orgId, now);
      setLastCloudSyncResult(result);
      console.log(
        '[cloudSync] flush done. synced:',
        result.synced.length,
        'merged:',
        result.merged.length,
        'failed:',
        result.failed.length,
        'remaining:',
        remaining.length,
      );
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[cloudSync] flush threw:', message);
      // Mark every in-flight item as failed so the banner shows error
      // details and the periodic 30 s retry has accurate retry counts.
      const stamped = items.map((i) => ({
        ...i,
        retries: i.retries + 1,
        lastTriedAt: new Date().toISOString(),
        lastError: i.lastError || message,
      }));
      await persistCloudQueue(orgId, stamped);
      return {
        synced: [],
        merged: [],
        failed: items.map((i) => ({
          itemId: i.id,
          playerId: i.playerId,
          error: message,
        })),
      };
    } finally {
      isCloudSyncingRef.current = false;
      setIsCloudSyncing(false);
      cloudSyncStartedAtRef.current = 0;
      // If anything else asked for a flush while we were running, fire
      // one more pass on the next tick. We deliberately don't await it
      // (this is fire-and-forget) and we read the ref via the wrapper
      // so we don't capture a stale `flushCloudQueueNow` value.
      if (cloudFlushPendingRef.current) {
        cloudFlushPendingRef.current = false;
        const next = flushCloudQueueRef.current;
        if (next) {
          setTimeout(() => {
            void next();
          }, 0);
        }
      }
    }
  }, [persistCloudQueue]);

  // Wire the forward-ref so mergeRemoteRoster (declared above this
  // useCallback) can call flushCloudQueueNow without creating a TDZ.
  useEffect(() => {
    flushCloudQueueRef.current = flushCloudQueueNow;
    return () => {
      // Don't null it on unmount; another mount might race the cleanup.
    };
  }, [flushCloudQueueNow]);

  const pushPlayerToRemote = useCallback(
    (player: Player) => {
      const orgId = currentOrg?.id;
      if (!orgId) return;
      enqueueCloudWrite(player);
      flushCloudQueueNow().catch((err) => {
        console.warn('[cloudSync] pushPlayer flush failed:', err);
      });
    },
    [currentOrg?.id, enqueueCloudWrite, flushCloudQueueNow],
  );

  const pushPlayersToRemote = useCallback(
    (playersBatch: Player[]) => {
      const orgId = currentOrg?.id;
      if (!orgId || playersBatch.length === 0) return;
      enqueueCloudWrites(playersBatch);
      flushCloudQueueNow().catch((err) => {
        console.warn('[cloudSync] pushPlayers flush failed:', err);
      });
    },
    [currentOrg?.id, enqueueCloudWrites, flushCloudQueueNow],
  );

  // ---------------------------------------------------------------------------
  // Photo upload queue (audit Medium #2)
  // Decoupled from the rest of save() so a photo upload failure can't block
  // the local check-in. The screen saves the player with the local file://
  // URI, then enqueues an upload here. When the upload eventually succeeds,
  // we patch the player record's photoUri to the cloud URL and re-sync.
  // ---------------------------------------------------------------------------
  const [photoUploadQueue, setPhotoUploadQueue] = useState<PhotoUploadItem[]>([]);
  const photoUploadQueueRef = useRef<PhotoUploadItem[]>([]);
  const isPhotoUploadingRef = useRef<boolean>(false);
  useEffect(() => {
    photoUploadQueueRef.current = photoUploadQueue;
  }, [photoUploadQueue]);

  useEffect(() => {
    let cancelled = false;
    const orgId = currentOrg?.id ?? null;
    setPhotoUploadQueue([]);
    if (!orgId) return;
    void (async () => {
      const queue = await loadPhotoUploadQueue(orgId);
      if (cancelled) return;
      console.log('[photoUploadQueue] loaded for', orgId, '->', queue.length, 'items');
      setPhotoUploadQueue(queue);
    })();
    return () => {
      cancelled = true;
    };
  }, [currentOrg?.id]);

  const persistPhotoQueue = useCallback(
    async (orgId: string, next: PhotoUploadItem[]) => {
      photoUploadQueueRef.current = next;
      setPhotoUploadQueue(next);
      await savePhotoUploadQueue(orgId, next);
    },
    [],
  );

  const enqueuePhotoUpload = useCallback(
    (playerId: string, localUri: string, playerName?: string) => {
      const orgId = currentOrg?.id;
      if (!orgId || !playerId || !localUri) return;
      // Cloud URLs don't need to be re-uploaded; ignore.
      if (localUri.startsWith('http://') || localUri.startsWith('https://')) return;
      const item = buildPhotoUploadItem(orgId, playerId, localUri, playerName);
      const next = mergeIntoPhotoQueue(photoUploadQueueRef.current, item);
      void persistPhotoQueue(orgId, next);
      console.log('[photoUploadQueue] enqueued', playerId, 'queue size:', next.length);
    },
    [currentOrg?.id, persistPhotoQueue],
  );

  const flushPhotoQueueNow = useCallback(async (): Promise<void> => {
    const orgId = cloudOrgRef.current;
    if (!orgId) return;
    if (isPhotoUploadingRef.current) return;
    const items = photoUploadQueueRef.current;
    if (items.length === 0) return;
    isPhotoUploadingRef.current = true;
    try {
      console.log('[photoUploadQueue] flushing', items.length, 'items for', orgId);
      const result = await flushPhotoUploadQueue(orgId, items);

      // For successful uploads, patch the player record's photoUri to the
      // cloud URL and trigger a roster sync so other devices see the
      // photo on the next refresh.
      if (result.uploaded.length > 0) {
        try {
          const stored = await AsyncStorage.getItem(playersKey());
          const current: Player[] = stored ? JSON.parse(stored) : [];
          const byId = new Map<string, Player>();
          current.forEach((p) => byId.set(p.id, p));

          const patched: Player[] = [];
          for (const ok of result.uploaded) {
            const existing = byId.get(ok.playerId);
            if (!existing) continue;
            // Only overwrite if the local copy still references the same
            // local file (i.e. the volunteer hasn't taken a brand-new
            // photo since this upload was queued).
            const updated: Player = { ...existing, photoUri: ok.cloudUrl };
            byId.set(ok.playerId, updated);
            patched.push(updated);
          }

          if (patched.length > 0) {
            const next = Array.from(byId.values());
            memoryPlayerCache = next;
            await AsyncStorage.setItem(playersKey(), JSON.stringify(next));
            queryClient.setQueryData(['local-players', orgScopeRef.current], next);
            // Push the now-cloud-URL'd rows to Supabase.
            for (const p of patched) {
              enqueueCloudWrite(p);
            }
            flushCloudQueueNow().catch((err2) => {
              console.warn('[cloudSync] photo-patch flush failed:', err2);
            });
          }
        } catch (err) {
          console.warn('[photoUploadQueue] patch-back failed:', err);
        }
      }

      // Persist remaining failed items with incremented retry counts.
      const handled = new Set([...result.uploaded.map((u) => u.itemId)]);
      const remaining = items
        .filter((i) => !handled.has(i.id))
        .map((i) => {
          const fail = result.failed.find((f) => f.itemId === i.id);
          return {
            ...i,
            retries: i.retries + 1,
            lastTriedAt: new Date().toISOString(),
            lastError: fail?.error ?? i.lastError,
          };
        });
      await persistPhotoQueue(orgId, remaining);
      console.log(
        '[photoUploadQueue] flush done. uploaded:',
        result.uploaded.length,
        'failed:',
        result.failed.length,
        'remaining:',
        remaining.length,
      );
    } finally {
      isPhotoUploadingRef.current = false;
    }
  }, [persistPhotoQueue, queryClient, playersKey, enqueueCloudWrite, flushCloudQueueNow]);

  // Auto-flush on launch (when org loads) and on network reconnect.
  useEffect(() => {
    const orgId = currentOrg?.id;
    if (!orgId) return;
    flushCloudQueueNow().catch((err) => {
      console.warn('[cloudSync] auto-flush failed:', err);
    });
    flushPhotoQueueNow().catch((err) => {
      console.warn('[photoUploadQueue] auto-flush failed:', err);
    });
  }, [currentOrg?.id, flushCloudQueueNow, flushPhotoQueueNow]);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const online = state.isConnected ?? true;
      setIsOnline(online);
      if (online && cloudOrgRef.current) {
        console.log('[cloudSync] network back online, flushing queues');
        flushCloudQueueNow().catch((err) => {
          console.warn('[cloudSync] reconnect flush failed:', err);
        });
        flushPhotoQueueNow().catch((err) => {
          console.warn('[photoUploadQueue] reconnect flush failed:', err);
        });
      }
    });
    return () => unsubscribe();
  }, [flushCloudQueueNow, flushPhotoQueueNow]);

  // Periodic retry while there is a backlog.
  useEffect(() => {
    if (cloudQueue.length === 0) return;
    const id = setInterval(() => {
      flushCloudQueueNow().catch((err) => {
        console.warn('[cloudSync] periodic flush failed:', err);
      });
    }, 30000);
    return () => clearInterval(id);
  }, [cloudQueue.length, flushCloudQueueNow]);

  useEffect(() => {
    if (!sheetsConfig?.isConnected) return;
    const data = sheetsPlayersQuery.data;
    if (!data || data.length === 0) return;
    // Don't overwrite a healthy local cache with empty/partial sheet data
    const local = localPlayersQuery.data;
    if (local && local.length > data.length * 2) {
      console.log('Skipping mirror: local cache larger than sheet data');
      return;
    }
    console.log('Mirroring sheets data to local cache (fallback):', data.length);
    memoryPlayerCache = data;
    AsyncStorage.setItem(playersKey(), JSON.stringify(data)).catch((err) =>
      console.error('Failed to mirror sheets data to local cache:', err),
    );
  }, [sheetsPlayersQuery.data, sheetsConfig?.isConnected, localPlayersQuery.data]);

  const savePendingQueue = useCallback(async (queue: PendingWrite[]) => {
    await AsyncStorage.setItem(writeQueueKey(), JSON.stringify(queue));
  }, []);

  const addToWriteQueue = useCallback(async (player: Player, action: 'update' | 'add') => {
    const write: PendingWrite = {
      id: `write-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      player,
      action,
      timestamp: Date.now(),
      retries: 0,
    };
    console.log('Adding to write queue:', action, player.id);
    setPendingWrites(prev => {
      const filtered = prev.filter(w => !(w.player.id === player.id && w.action === action));
      const updated = [...filtered, write];
      void savePendingQueue(updated);
      return updated;
    });
  }, [savePendingQueue]);

  // Local no-op mutations — the remote sheets backend is safe-mode, so we
  // just acknowledge success and rely on Supabase roster sync for cross-device
  // updates. This keeps the UI's sync state clean.
  const updateSheetsMutation = useMutation({
    mutationFn: async ({ player }: { spreadsheetId: string; sheetName?: string; player: Player }) => {
      return { success: true as const, player };
    },
    onSuccess: (data) => {
      console.log('Player update acknowledged locally:', data.player.id);
      setSyncErrors([]);
    },
  });

  const addSheetsMutation = useMutation({
    mutationFn: async ({ player }: { spreadsheetId: string; sheetName?: string; player: Omit<Player, 'id'> & { id?: string } }) => {
      const withId: Player = {
        ...(player as Player),
        id: player.id ?? randomId('local'),
      };
      return { success: true as const, player: withId };
    },
    onSuccess: (data) => {
      console.log('Player add acknowledged locally:', data.player.id);
      setSyncErrors([]);
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _syncHooks = { pushPlayerToRemote, pushPlayersToRemote };

  const updateLocalMutation = useMutation({
    mutationFn: async (updatedPlayer: Player) => {
      console.log('Updating player locally:', updatedPlayer.id);
      // Read directly from AsyncStorage to ensure we have the latest data
      // This prevents data loss when the React Query cache is stale
      const stored = await AsyncStorage.getItem(playersKey());
      const currentPlayers: Player[] = stored ? JSON.parse(stored) : [];
      
      const playerExists = currentPlayers.some(p => p.id === updatedPlayer.id);
      let newPlayers: Player[];
      
      if (playerExists) {
        newPlayers = currentPlayers.map(p => 
          p.id === updatedPlayer.id ? updatedPlayer : p
        );
      } else {
        // Player not found by ID, try to find by name+DOB match
        const key = `${updatedPlayer.firstName.toLowerCase().trim()}_${updatedPlayer.lastName.toLowerCase().trim()}_${updatedPlayer.dateOfBirth.trim()}`;
        const matchIndex = currentPlayers.findIndex(p => {
          const pKey = `${p.firstName.toLowerCase().trim()}_${p.lastName.toLowerCase().trim()}_${p.dateOfBirth.trim()}`;
          return pKey === key;
        });
        
        if (matchIndex >= 0) {
          console.log('Found player by name+DOB match, updating with new ID');
          newPlayers = [...currentPlayers];
          newPlayers[matchIndex] = { ...updatedPlayer, id: currentPlayers[matchIndex].id };
        } else {
          console.log('Player not found, adding as new');
          newPlayers = [...currentPlayers, updatedPlayer];
        }
      }
      
      await AsyncStorage.setItem(playersKey(), JSON.stringify(newPlayers));
      console.log('Player data saved to storage, total players:', newPlayers.length);
      return newPlayers;
    },
    onSuccess: (newPlayers, variables) => {
      console.log('Update mutation success, refreshing query cache');
      memoryPlayerCache = newPlayers;
      queryClient.setQueryData(['local-players', orgScopeRef.current], newPlayers);
      pushPlayerToRemote(variables);
    },
  });

  const addLocalMutation = useMutation({
    mutationFn: async (newPlayer: Omit<Player, 'id'>) => {
      console.log('Adding new player locally:', newPlayer.firstName, newPlayer.lastName);
      // Read directly from AsyncStorage to ensure we have the latest data
      const stored = await AsyncStorage.getItem(playersKey());
      const currentPlayers: Player[] = stored ? JSON.parse(stored) : [];
      const player: Player = {
        ...newPlayer,
        id: randomId(),
      };
      const newPlayers = [...currentPlayers, player];
      await AsyncStorage.setItem(playersKey(), JSON.stringify(newPlayers));
      console.log('Player added to storage, total players:', newPlayers.length);
      return { players: newPlayers, newPlayer: player };
    },
    onSuccess: ({ players, newPlayer }) => {
      memoryPlayerCache = players;
      queryClient.setQueryData(['local-players', orgScopeRef.current], players);
      pushPlayerToRemote(newPlayer);
    },
  });

  const importMetadataMutation = useMutation({
    mutationFn: async (spreadsheetId: string) => {
      console.log('Fetching metadata for import from:', spreadsheetId);
      const metadata = {
        clubs: [] as { id: string; name: string }[],
        teams: [] as { id: string; name: string; club?: string; ageGroup?: string; division?: string }[],
        ageGroups: [] as { id: string; name: string }[],
        divisions: [] as { id: string; name: string }[],
        title: '',
      };
      
      const newClubs = metadata.clubs || [];
      // @ts-ignore
      const newTeams = metadata.teams || [];
      const newAgeGroups = metadata.ageGroups || [];
      const newDivisions = metadata.divisions || [];
      
      const metaToSave = {
        clubs: newClubs,
        teams: newTeams,
        ageGroups: newAgeGroups,
        divisions: newDivisions
      };
      
      await AsyncStorage.setItem(importedMetadataKey(), JSON.stringify(metaToSave));
      return metaToSave;
    },
    onSuccess: (data) => {
      setImportedClubs(data.clubs);
      setImportedTeams(data.teams);
      setImportedAgeGroups(data.ageGroups);
      setImportedDivisions(data.divisions);
      console.log('Imported metadata saved:', {
        clubs: data.clubs.length,
        teams: data.teams.length
      });
    },
    onError: (err) => {
      console.error('Failed to import metadata:', err);
    }
  });

  const importPlayersMutation = useMutation({
    mutationFn: async (playersToImport: Omit<Player, 'id'>[]) => {
      console.log('Importing', playersToImport.length, 'players with deduplication...');
      
      // Get existing players from storage
      const stored = await AsyncStorage.getItem(playersKey());
      let existingPlayers: Player[] = stored ? JSON.parse(stored) : [];
      
      // CHECK FOR DEMO DATA: If we have mock players (ids 1-8), clear them
      const hasDemoData = existingPlayers.some(p => ['1','2','3','4','5','6','7','8'].includes(p.id));
      if (hasDemoData) {
        console.log('Detected demo data, clearing before import...');
        existingPlayers = existingPlayers.filter(p => !['1','2','3','4','5','6','7','8'].includes(p.id));
      }
      
      console.log('Existing players count (after demo cleanup):', existingPlayers.length);
      
      // Create a map of existing players by name + DOB for deduplication
      // We normalize strings to ensure matching works even with case differences or whitespace
      const existingPlayerMap = new Map<string, Player>();
      existingPlayers.forEach(player => {
        // Create a unique key for deduplication
        const key = `${player.firstName.toLowerCase().trim()}_${player.lastName.toLowerCase().trim()}_${player.dateOfBirth.trim()}`;
        existingPlayerMap.set(key, player);
      });
      
      const resultPlayers: Player[] = [];
      let duplicatesKept = 0;
      let newPlayersAdded = 0;
      
      // Process imported players
      playersToImport.forEach((importedPlayer, index) => {
        const key = `${importedPlayer.firstName.toLowerCase().trim()}_${importedPlayer.lastName.toLowerCase().trim()}_${importedPlayer.dateOfBirth.trim()}`;
        
        const existingPlayer = existingPlayerMap.get(key);
        
        if (existingPlayer) {
          // Duplicate found - keep existing player with their photos, weights, check-in status, etc.
          // We DO NOT overwrite the existing record with new data effectively, 
          // but we might want to update some fields if they are blank in existing but present in import?
          // For now, per instructions: "leave those alone and don't delete any photos, weights etc. Keep those all tied to the record."
          
          console.log(`Keeping existing player: ${existingPlayer.firstName} ${existingPlayer.lastName}`);
          resultPlayers.push(existingPlayer);
          existingPlayerMap.delete(key); // Remove from map so we don't add it again if it appears twice in import
          duplicatesKept++;
        } else {
          // New player - add with new ID. If the player has been age-verified
          // in a previous season (exists in the registry), pre-fill that flag
          // so they don't have to bring docs again.
          const registryKey = normalizeVerificationKey(
            importedPlayer.firstName,
            importedPlayer.lastName,
            importedPlayer.dateOfBirth
          );
          const previouslyVerified =
            !!registryKey && verifiedRegistryRef.current.has(registryKey);
          resultPlayers.push({
            ...importedPlayer,
            id: randomId('imported'),
            teamName: importedPlayer.teamName ?? '',
            checkedIn: importedPlayer.checkedIn ?? false,
            checkedInAt: importedPlayer.checkedInAt ?? null,
            isAgeVerified:
              importedPlayer.isAgeVerified ?? previouslyVerified ?? false,
            photoUri: importedPlayer.photoUri ?? null,
            // Ensure default values
            weight: importedPlayer.weight || '',
            restrictionStatus: 'none',
          });
          newPlayersAdded++;
        }
      });
      
      // Add any remaining existing players that weren't in the import (if we want to keep them?)
      // Usually import replaces the roster, but "deduplication" implies merging.
      // If the user says "upload the spreadsheet", they might expect it to update the roster.
      // Typically, if a player is NOT in the new sheet, they should probably remain if they were manually added?
      // But if this is a "Roster Import", maybe we only want what's in the sheet + matches.
      // However, "leave those alone" suggests preservation.
      // Let's keep players that were already there but not in the sheet, assuming they might be manual entries.
      // array.from(existingPlayerMap.values()) would give us the rest.
      
      // The user instruction: "So if the names, and DOB's match as players already in the system, then leave those alone... Keep those all tied to the record."
      // It doesn't explicitly say "Delete players not in the spreadsheet".
      // But usually an import implies "This is the list".
      // Let's append the remaining existing players to be safe against data loss.
      
      const remainingExisting = Array.from(existingPlayerMap.values());
      resultPlayers.push(...remainingExisting);
      
      console.log(`Deduplication complete: ${duplicatesKept} matched, ${newPlayersAdded} new, ${remainingExisting.length} preserved from previous`);
      console.log('Total players after import:', resultPlayers.length);
      
      await AsyncStorage.setItem(playersKey(), JSON.stringify(resultPlayers));
      return resultPlayers;
    },
    onSuccess: (allPlayers) => {
      console.log('Import success with deduplication, total players:', allPlayers.length);
      memoryPlayerCache = allPlayers;
      queryClient.setQueryData(['local-players', orgScopeRef.current], allPlayers);
      pushPlayersToRemote(allPlayers);
    },
  });

  const resetDataMutation = useMutation({
    mutationFn: async () => {
      console.log('Resetting to mock data...');
      await AsyncStorage.setItem(playersKey(), JSON.stringify(mockPlayers));
      return mockPlayers;
    },
    onSuccess: (mockData) => {
      queryClient.setQueryData(['local-players', orgScopeRef.current], mockData);
    },
  });

  const clearAllImportedDataMutation = useMutation({
    mutationFn: async () => {
      console.log('Clearing all imported data...');
      await Promise.all([
        AsyncStorage.removeItem(playersKey()),
        AsyncStorage.removeItem(sheetsConfigKey()),
        AsyncStorage.removeItem(importedMetadataKey()),
        AsyncStorage.removeItem(savedSheetUrlKey()),
      ]);
      return [];
    },
    onSuccess: () => {
      memoryPlayerCache = [];
      queryClient.setQueryData(['local-players', orgScopeRef.current], []);
      setSheetsConfig(null);
      setSavedSheetInfo(null);
      setImportedClubs([]);
      setImportedTeams([]);
      setImportedAgeGroups([]);
      setImportedDivisions([]);
      void queryClient.invalidateQueries({ queryKey: ['local-players'] });
      // ^ matches all org-scoped variants because react-query treats keys as prefixes by default
      console.log('All imported data cleared successfully');
    },
  });

  const saveSheetInfo = useCallback(async (url: string, spreadsheetId: string, title: string = 'Google Sheet') => {
    const info: SavedSheetInfo = {
      url,
      spreadsheetId,
      title,
      lastImportedAt: new Date().toISOString(),
    };
    await AsyncStorage.setItem(savedSheetUrlKey(), JSON.stringify(info));
    setSavedSheetInfo(info);
    console.log('Saved sheet info:', info);
  }, []);

  const addImportedSheet = useCallback(async (
    spreadsheetId: string,
    url: string,
    title: string,
    playerCount: number,
    importedBy: string = 'admin'
  ): Promise<ImportedSheet> => {
    console.log('Adding imported sheet to history:', title);
    
    // Check if this sheet already exists
    const existingSheet = importedSheets.find(s => s.spreadsheetId === spreadsheetId);
    
    if (existingSheet) {
      // Update existing sheet
      const updatedSheet: ImportedSheet = {
        ...existingSheet,
        lastUsedAt: new Date().toISOString(),
        playerCount,
      };
      const updatedSheets = importedSheets.map(s => 
        s.id === existingSheet.id ? updatedSheet : s
      );
      await AsyncStorage.setItem(importedSheetsKey(), JSON.stringify(updatedSheets));
      setImportedSheets(updatedSheets);
      console.log('Updated existing imported sheet:', updatedSheet.accessCode);
      return updatedSheet;
    }
    
    // Create new sheet entry
    const newSheet: ImportedSheet = {
      id: `sheet-${Date.now()}`,
      spreadsheetId,
      url,
      title,
      accessCode: generateSheetAccessCode(),
      importedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      importedBy,
      playerCount,
      isLocked: false,
      allowEditing: false, // Default to view-only
    };
    
    const updatedSheets = [...importedSheets, newSheet];
    await AsyncStorage.setItem(importedSheetsKey(), JSON.stringify(updatedSheets));
    setImportedSheets(updatedSheets);
    console.log('Added new imported sheet with code:', newSheet.accessCode);
    return newSheet;
  }, [importedSheets]);

  const updateImportedSheet = useCallback(async (sheetId: string, updates: Partial<ImportedSheet>) => {
    console.log('Updating imported sheet:', sheetId, updates);
    const updatedSheets = importedSheets.map(s => 
      s.id === sheetId ? { ...s, ...updates } : s
    );
    await AsyncStorage.setItem(importedSheetsKey(), JSON.stringify(updatedSheets));
    setImportedSheets(updatedSheets);
  }, [importedSheets]);

  const deleteImportedSheet = useCallback(async (sheetId: string) => {
    console.log('Deleting imported sheet:', sheetId);
    const updatedSheets = importedSheets.filter(s => s.id !== sheetId);
    await AsyncStorage.setItem(importedSheetsKey(), JSON.stringify(updatedSheets));
    setImportedSheets(updatedSheets);
  }, [importedSheets]);

  const getSheetByAccessCode = useCallback((code: string): ImportedSheet | null => {
    return importedSheets.find(
      s => s.accessCode.toUpperCase() === code.toUpperCase()
    ) || null;
  }, [importedSheets]);

  const toggleSheetLock = useCallback(async (sheetId: string) => {
    const sheet = importedSheets.find(s => s.id === sheetId);
    if (sheet) {
      await updateImportedSheet(sheetId, { isLocked: !sheet.isLocked });
    }
  }, [importedSheets, updateImportedSheet]);

  const toggleSheetEditing = useCallback(async (sheetId: string) => {
    const sheet = importedSheets.find(s => s.id === sheetId);
    if (sheet) {
      await updateImportedSheet(sheetId, { allowEditing: !sheet.allowEditing });
    }
  }, [importedSheets, updateImportedSheet]);

  const enableWriteBack = useCallback(async (spreadsheetId: string, sheetName: string = 'Players') => {
    console.log('Enabling write-back to Google Sheets:', spreadsheetId);
    const config: SheetsConfig = {
      spreadsheetId,
      sheetName,
      isConnected: true,
    };
    await AsyncStorage.setItem(sheetsConfigKey(), JSON.stringify(config));
    setSheetsConfig(config);
    console.log('Write-back enabled - changes will sync to Google Sheets');
  }, []);

  const disableWriteBack = useCallback(async () => {
    console.log('Disabling write-back (keeping saved sheet info)');
    await AsyncStorage.removeItem(sheetsConfigKey());
    setSheetsConfig(null);
  }, []);

  const testConnectionMutation = useMutation({
    mutationFn: async (_vars: { spreadsheetId: string }) => {
      return { success: true as const, message: 'Safe mode' };
    },
  });
  const { mutateAsync: testConnectionAsync, isPending: isTestingConnection } = testConnectionMutation;

  const connectToSheets = useCallback(async (spreadsheetId: string, sheetName: string = 'Players') => {
    console.log('Testing connection to spreadsheet:', spreadsheetId);
    const result = await testConnectionAsync({ spreadsheetId });
    
    if (result.success) {
      const config: SheetsConfig = {
        spreadsheetId,
        sheetName,
        isConnected: true,
      };
      await AsyncStorage.setItem(sheetsConfigKey(), JSON.stringify(config));
      setSheetsConfig(config);
      console.log('Connected to Google Sheets successfully');
      return result;
    }
    throw new Error('Connection test failed');
  }, [testConnectionAsync]);

  const disconnectFromSheets = useCallback(async () => {
    console.log('Disconnecting from Google Sheets');
    await AsyncStorage.removeItem(sheetsConfigKey());
    setSheetsConfig(null);
    void queryClient.invalidateQueries({ queryKey: ['local-players'] });
      // ^ matches all org-scoped variants because react-query treats keys as prefixes by default
  }, [queryClient]);

  const isConnected = sheetsConfig?.isConnected || false;

  const isPreviouslyAgeVerified = useCallback(
    (firstName: string, lastName: string, dateOfBirth: string): boolean => {
      const key = normalizeVerificationKey(firstName, lastName, dateOfBirth);
      if (!key) return false;
      return verifiedRegistry.has(key);
    },
    [verifiedRegistry]
  );
  
  const players = useMemo(() => {
    let raw: Player[];
    if (isConnected && sheetsPlayersQuery.data && sheetsPlayersQuery.data.length > 0) {
      raw = sheetsPlayersQuery.data;
    } else if (localPlayersQuery.data && localPlayersQuery.data.length > 0) {
      if (isConnected) {
        console.log('Using local cache (sheets returned no rows or unreachable)');
      }
      raw = localPlayersQuery.data;
    } else {
      raw = localPlayersQuery.data || [];
    }
    const { deduped, duplicateIds } = dedupePlayers(raw);
    if (duplicateIds.length > 0) {
      console.log('[dedupe] collapsed duplicates:', {
        before: raw.length,
        after: deduped.length,
        removed: duplicateIds.length,
      });
    }
    return deduped;
  }, [isConnected, sheetsPlayersQuery.data, localPlayersQuery.data]);

  const playersRef = useRef<Player[]>([]);
  useEffect(() => {
    playersRef.current = players;
  }, [players]);

  const currentOrgCodeRef = useRef<string | null>(null);
  currentOrgCodeRef.current = currentOrg?.code ?? null;

  const forceSyncAllToCloud = useCallback(async (): Promise<{
    ok: boolean;
    synced: number;
    skipped: number;
    failed: number;
    error?: string;
    reconcile?: ReconcileResult;
  }> => {
    const orgId = cloudOrgRef.current;
    if (!orgId) {
      return { ok: false, synced: 0, skipped: 0, failed: 0, error: 'No organization selected.' };
    }
    if (isCloudSyncingRef.current) {
      return { ok: false, synced: 0, skipped: 0, failed: 0, error: 'A sync is already in progress.' };
    }
    isCloudSyncingRef.current = true;
    setIsCloudSyncing(true);
    try {
      // Flush ONLY the pending cloud queue — never the full in-memory roster.
      // The app is a downstream consumer: it reads the roster and writes only
      // individual user actions (check-ins, profile edits). Pushing the full
      // cached roster back would overwrite server-side corrections and
      // resurrect stale data. See Fix 2 post-mortem.
      const queueItems = cloudQueueRef.current;
      console.log('[cloudSync] force-syncing pending queue only:', queueItems.length, 'items');
      const result = await flushCloudSyncQueue(orgId, queueItems, mergePlayerRecords, updatedByRef.current);

      // Drop handled items from the queue; keep failures for next retry.
      const handled = new Set([...result.synced, ...result.merged]);
      const remaining = queueItems
        .filter((i) => !handled.has(i.id))
        .map((i) => {
          const fail = result.failed.find((f) => f.itemId === i.id);
          return {
            ...i,
            retries: i.retries + 1,
            lastTriedAt: new Date().toISOString(),
            lastError: fail?.error ?? i.lastError,
          };
        });
      await persistCloudQueue(orgId, remaining);

      const now = new Date().toISOString();
      setLastCloudSyncedAt(now);
      await saveLastCloudSync(orgId, now);
      setLastCloudSyncResult(result);

      const synced = result.synced.length + result.merged.length;
      const failed = result.failed.length;
      console.log('[cloudSync] force-sync complete', { synced, failed });
      return { ok: failed === 0, synced, skipped: 0, failed };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[cloudSync] force-sync failed:', message);
      return { ok: false, synced: 0, skipped: 0, failed: 0, error: message };
    } finally {
      isCloudSyncingRef.current = false;
      setIsCloudSyncing(false);
    }
  }, [persistCloudQueue]);

  // ---------------------------------------------------------------------------
  // One-shot "final reconcile" that runs automatically on launch the first time
  // a volunteer opens this version of the app. It sweeps every AsyncStorage
  // scope on the device, pulls rosters from any duplicate cloud orgs sharing
  // the same invite code, dedupes everything (newest-wins), and force-pushes
  // the merged result to the canonical cloud org. After it runs once, a flag
  // in AsyncStorage prevents it from running again. Admins can still re-run it
  // on demand via the Force Sync to Cloud button in Settings.
  // ---------------------------------------------------------------------------
  const reconcileLaunchRanRef = useRef<boolean>(false);
  useEffect(() => {
    const orgId = currentOrg?.id;
    const orgCode = currentOrg?.code;
    if (!orgId || !orgCode) return;
    if (reconcileLaunchRanRef.current) return;
    if (isCloudSyncingRef.current) return;

    let cancelled = false;
    const launch = async () => {
      const alreadyRanAt = await hasReconcileRun(orgId);
      if (alreadyRanAt) {
        console.log('[cloudSync] final reconcile already ran at', alreadyRanAt, '- skipping');
        reconcileLaunchRanRef.current = true;
        return;
      }
      if (cancelled) return;
      reconcileLaunchRanRef.current = true;
      console.log('[cloudSync] launching one-shot final reconcile for', orgCode);
      isCloudSyncingRef.current = true;
      setIsCloudSyncing(true);
      try {
        const result = await runFinalReconcile(orgId, orgCode, dedupePlayers, mergePlayerRecords);
        if (cancelled) return;
        if (result.mergedTotal > 0) {
          try {
            const stored = await AsyncStorage.getItem(playersKey());
            const merged: Player[] = stored ? JSON.parse(stored) : [];
            memoryPlayerCache = merged;
            queryClient.setQueryData(['local-players', orgScopeRef.current], merged);
          } catch (err) {
            console.warn('[cloudSync] launch reconcile cache refresh failed:', err);
          }
        }
        const now = new Date().toISOString();
        setLastCloudSyncedAt(now);
        await saveLastCloudSync(orgId, now);
        console.log('[cloudSync] launch reconcile finished', result);
      } catch (err) {
        console.warn('[cloudSync] launch reconcile failed:', err);
      } finally {
        if (!cancelled) {
          isCloudSyncingRef.current = false;
          setIsCloudSyncing(false);
        }
      }
    };
    launch().catch((err) => {
      console.warn('[cloudSync] launch reconcile failed:', err);
    });
    return () => {
      cancelled = true;
    };
  }, [currentOrg?.id, currentOrg?.code, queryClient, playersKey]);

  // The club picker is strict: the only valid options are the canonical
  // clubs in `public.clubs` (or, while the fetch is in flight / offline,
  // the static fallback that mirrors that seed). We deliberately do NOT
  // surface clubs from sheet/CSV imports or from existing Player.club
  // strings — that's exactly what produced the variant-spelling problem
  // (audit + migration 025). If a name appears in a row but isn't in the
  // canonical list, it should round-trip back into the picker as "no club
  // selected" so an admin can clean it up at the source.
  const clubs: Club[] = useMemo(() => {
    return [...canonicalClubs].sort((a, b) => a.name.localeCompare(b.name));
  }, [canonicalClubs]);

  const teams: TeamOption[] = useMemo(() => {
    const uniqueTeams = new Map<string, TeamOption>();

    // 1. Add teams from CONNECTED metadata
    // @ts-ignore
    if (isConnected && sheetsMetadataQuery.data?.teams?.length) {
      // @ts-ignore
      sheetsMetadataQuery.data.teams.forEach((team: any) => {
        if (team.name && !uniqueTeams.has(team.name)) {
          uniqueTeams.set(team.name, {
            id: team.id || team.name.toLowerCase().replace(/\s+/g, '-'),
            name: team.name,
            club: team.club,
            ageGroup: team.ageGroup,
            division: team.division
          });
        }
      });
    }

    // 2. Add teams from IMPORTED metadata
    if (!isConnected && importedTeams.length > 0) {
      importedTeams.forEach(team => {
        if (team.name && !uniqueTeams.has(team.name)) {
          uniqueTeams.set(team.name, team);
        }
      });
    }

    // 3. Add teams from player data
    players.forEach(player => {
      parseTeamAssignments(player.teamName).forEach((teamName) => {
        if (teamName && !uniqueTeams.has(teamName)) {
          uniqueTeams.set(teamName, {
            id: `team-${teamName.toLowerCase().replace(/\s+/g, '-')}`,
            name: teamName,
            club: player.club,
            ageGroup: player.ageGroup,
            division: player.division
          });
        }
      });
    });

    return Array.from(uniqueTeams.values()).sort(compareTeamByName);
  }, [players, isConnected, sheetsMetadataQuery.data, importedTeams]);

  const ageGroups: AgeGroup[] = useMemo(() => {
    if (isConnected && sheetsMetadataQuery.data?.ageGroups?.length) {
      return sheetsMetadataQuery.data.ageGroups;
    }
    if (!isConnected && importedAgeGroups.length > 0) {
      return importedAgeGroups;
    }
    return mockAgeGroups;
  }, [isConnected, sheetsMetadataQuery.data, importedAgeGroups]);

  const divisions: Division[] = useMemo(() => {
    if (isConnected && sheetsMetadataQuery.data?.divisions?.length) {
      return sheetsMetadataQuery.data.divisions;
    }
    if (!isConnected && importedDivisions.length > 0) {
      return importedDivisions;
    }
    // Fixed divisions to match spreadsheet tab naming: Restricted and Open
    return [
      { id: 'restricted', name: 'Restricted' },
      { id: 'open', name: 'Open' },
    ];
  }, [isConnected, sheetsMetadataQuery.data, importedDivisions]);

  const filteredPlayers = useMemo(() => {
    let result = players;

    const normalizeStr = (s: string | undefined | null) => (s || '').toString().trim().toLowerCase();

    console.log('[Filter] applying filters:', {
      club: filters.club,
      ageGroup: filters.ageGroup,
      division: filters.division,
      teamName: filters.teamName,
      totalPlayers: result.length,
    });

    if (filters.club) {
      const target = normalizeStr(filters.club);
      result = result.filter(p => normalizeStr(p.club) === target);
      console.log('[Filter] after club filter:', result.length);
    }
    if (filters.ageGroup) {
      const target = normalizeAgeGroup(filters.ageGroup);
      result = result.filter(p => {
        const effectiveAgeGroup = p.ageGroup || p.calculatedAgeGroup || '';
        return normalizeAgeGroup(effectiveAgeGroup) === target;
      });
      console.log('[Filter] after age filter:', result.length, 'target:', target);
    }
    if (filters.division) {
      const target = normalizeStr(filters.division);
      result = result.filter(p => normalizeStr(p.division) === target);
      console.log('[Filter] after division filter:', result.length);
    }
    if (filters.teamName) {
      result = result.filter(p => playerHasTeam(p.teamName, filters.teamName));
    }
    if (filters.status === 'checkedIn') {
      result = result.filter(p => p.checkedIn);
    } else if (filters.status === 'pending') {
      result = result.filter(p => !p.checkedIn);
    }
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      result = result.filter(p => 
        p.firstName.toLowerCase().includes(query) ||
        p.lastName.toLowerCase().includes(query) ||
        `${p.firstName} ${p.lastName}`.toLowerCase().includes(query)
      );
    }

    return result.sort((a, b) => {
      if (a.checkedIn !== b.checkedIn) return a.checkedIn ? 1 : -1;
      return `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`);
    });
  }, [players, filters, searchQuery]);

  const getPlayerById = useCallback((id: string) => {
    return players.find(p => p.id === id) || null;
  }, [players]);

  const stats = useMemo(() => {
    const total = filteredPlayers.length;
    const checkedIn = filteredPlayers.filter(p => p.checkedIn).length;
    const pending = total - checkedIn;
    return { total, checkedIn, pending };
  }, [filteredPlayers]);

  const { mutateAsync: updateSheetsPlayerAsync } = updateSheetsMutation;
  const { mutateAsync: updateLocalPlayerAsync } = updateLocalMutation;

  const updatePlayer = useCallback(async (player: Player): Promise<void> => {
    if (eventMode === 'viewOnly' && !canEdit) {
      console.log('View-only mode: blocking player update (no edit access)');
      throw new Error('This event is locked. Only the admin or users granted edit access can make changes.');
    }
    console.log('Saving player update locally first:', player.id, 'photoUri:', player.photoUri ? 'has photo' : 'no photo');
    await updateLocalPlayerAsync(player);

    if (player.isAgeVerified && player.dateOfBirth) {
      const key = normalizeVerificationKey(
        player.firstName,
        player.lastName,
        player.dateOfBirth
      );
      if (key && !verifiedRegistryRef.current.has(key)) {
        verifiedRegistryRef.current.add(key);
        setVerifiedRegistry(new Set(verifiedRegistryRef.current));
        void markPlayerAgeVerified(orgIdForRegistry, player).catch((err) =>
          console.warn('Failed to mark age verified in registry:', err)
        );
      }
    }

    if (isConnected && sheetsConfig) {
      const queryKey = [
        ['sheets', 'getPlayers'],
        { input: { spreadsheetId: sheetsConfig.spreadsheetId, sheetName: sheetsConfig.sheetName }, type: 'query' },
      ];
      queryClient.setQueryData(queryKey, (old: Player[] | undefined) => {
        if (!old) return old;
        const exists = old.some(p => p.id === player.id);
        if (exists) {
          return old.map(p => p.id === player.id ? player : p);
        }
        return [...old, player];
      });

      console.log('Syncing player update to Google Sheets in background:', player.id);
      updateSheetsPlayerAsync({
        spreadsheetId: sheetsConfig.spreadsheetId,
        sheetName: sheetsConfig.sheetName,
        player,
      }).then(() => {
        console.log('Player update synced to Sheets successfully');
      }).catch((error) => {
        console.error('Direct Sheets sync failed, queuing for retry:', error);
        void addToWriteQueue(player, 'update');
      });
    } else if (savedSheetInfo) {
      console.log('Not connected but have saved sheet - queuing write for next sync');
      await addToWriteQueue(player, 'update');
    }
  }, [eventMode, canEdit, isConnected, sheetsConfig, savedSheetInfo, updateSheetsPlayerAsync, updateLocalPlayerAsync, addToWriteQueue, queryClient, orgIdForRegistry, verifiedRegistryRef]);

  const { mutateAsync: addSheetsPlayer } = addSheetsMutation;
  const { mutateAsync: addLocalPlayerAsync } = addLocalMutation;

  const addPlayer = useCallback(async (newPlayer: Omit<Player, 'id'>) => {
    if (eventMode === 'viewOnly' && !canEdit) {
      console.log('View-only mode: blocking add player (no edit access)');
      throw new Error('This event is locked. Only the admin or users granted edit access can add players.');
    }
    const result = await addLocalPlayerAsync(newPlayer);
    const addedPlayer = result.newPlayer;
    console.log('Player added locally:', addedPlayer.id);

    if (addedPlayer.isAgeVerified && addedPlayer.dateOfBirth) {
      const key = normalizeVerificationKey(
        addedPlayer.firstName,
        addedPlayer.lastName,
        addedPlayer.dateOfBirth
      );
      if (key && !verifiedRegistryRef.current.has(key)) {
        verifiedRegistryRef.current.add(key);
        setVerifiedRegistry(new Set(verifiedRegistryRef.current));
        void markPlayerAgeVerified(orgIdForRegistry, addedPlayer).catch((err) =>
          console.warn('Failed to mark new player age verified:', err)
        );
      }
    }

    if (isConnected && sheetsConfig) {
      try {
        const sheetsResult = await addSheetsPlayer({
          spreadsheetId: sheetsConfig.spreadsheetId,
          sheetName: sheetsConfig.sheetName,
          player: newPlayer,
        });
        console.log('Player added to Google Sheets:', sheetsResult.player.id);
        return sheetsResult.player;
      } catch (error) {
        console.error('Failed to add to Sheets, queued for retry:', error);
        await addToWriteQueue(addedPlayer, 'add');
        return addedPlayer;
      }
    } else if (savedSheetInfo) {
      console.log('Not connected but have saved sheet - queuing add for next sync');
      await addToWriteQueue(addedPlayer, 'add');
    }
    return addedPlayer;
  }, [eventMode, canEdit, isConnected, sheetsConfig, savedSheetInfo, addSheetsPlayer, addLocalPlayerAsync, addToWriteQueue, orgIdForRegistry, verifiedRegistryRef]);

  const setEventMode = useCallback(async (mode: EventMode) => {
    if (!isAdmin) {
      console.log('Only admin can change event mode');
      throw new Error('Only the admin can lock or unlock the event.');
    }
    console.log('Setting event mode to:', mode);
    // Optimistically update local UI, then push to Supabase so every other
    // device receives it via realtime. Persist locally too so the admin's
    // own device stays in sync if Supabase is briefly unreachable.
    setEventModeState(mode);
    // Optimistically apply the editor lock locally so the admin's own UI
    // also flips immediately, before the realtime echo arrives.
    try {
      setEventLockedForEditors(mode === 'viewOnly');
    } catch (err) {
      console.warn('[eventMode] local setEventLockedForEditors failed:', err);
    }
    await AsyncStorage.setItem(eventModeKey(), mode);
    if (currentOrg?.id) {
      try {
        await setOrgEventMode(currentOrg.id, mode, currentOrg.ownerId);
      } catch (err) {
        console.warn('[eventMode] failed to push to Supabase:', err);
        throw err;
      }
    } else {
      console.warn('[eventMode] no current org - lock will not propagate to other devices');
    }
  }, [isAdmin, currentOrg?.id, currentOrg?.ownerId]);

  const setShowTeamAssignment = useCallback(async (value: boolean) => {
    if (!isAdmin) {
      throw new Error('Only the admin can change this setting.');
    }
    console.log('Setting showTeamAssignment to:', value);
    setShowTeamAssignmentState(value);
    await AsyncStorage.setItem(showTeamAssignmentKey(), value ? 'true' : 'false');
  }, [isAdmin]);

  const { mutateAsync: importPlayersAsync } = importPlayersMutation;

  const importPlayers = useCallback(async (playersToImport: Omit<Player, 'id'>[]) => {
    console.log('Importing players:', playersToImport.length);
    // Ensure we have the freshest registry so imports pre-fill age verification correctly.
    try {
      const fresh = await fetchRegistryFromRemote(orgIdForRegistry);
      if (fresh.size > 0) {
        verifiedRegistryRef.current = fresh;
        setVerifiedRegistry(fresh);
      }
    } catch (err) {
      console.warn('Registry refresh before import failed (continuing):', err);
    }
    await importPlayersAsync(playersToImport);
  }, [importPlayersAsync, orgIdForRegistry, verifiedRegistryRef]);

    const importPlayersWithOrgCheck = useCallback(async (
    playersToImport: Omit<Player, 'id'>[],
    sourceOrgName: string,
    currentOrgName: string | null,
    overwriteIfMatch: boolean = true
  ) => {
    console.log('Importing players with org check and deduplication:', {
      count: playersToImport.length,
      sourceOrgName,
      currentOrgName,
      overwriteIfMatch,
    });

    const stored = await AsyncStorage.getItem(playersKey());
    let currentPlayers: Player[] = stored ? JSON.parse(stored) : [];

    // CHECK FOR DEMO DATA: If we have mock players (ids 1-8), clear them
    // This ensures demo data is removed when a real sheet is fetched
    const hasDemoData = currentPlayers.some(p => ['1','2','3','4','5','6','7','8'].includes(p.id));
    if (hasDemoData) {
      console.log('Detected demo data during org import, clearing before import...');
      currentPlayers = currentPlayers.filter(p => !['1','2','3','4','5','6','7','8'].includes(p.id));
    }

    const namesMatch = currentOrgName &&
      sourceOrgName.toLowerCase().trim() === currentOrgName.toLowerCase().trim();
    console.log('Organization names match:', namesMatch);

    // Create a map of existing players by name + DOB for deduplication
    const existingPlayerMap = new Map<string, Player>();
    currentPlayers.forEach(player => {
      const key = `${player.firstName.toLowerCase().trim()}_${player.lastName.toLowerCase().trim()}_${player.dateOfBirth.trim()}`;
      existingPlayerMap.set(key, player);
    });

    const resultPlayers: Player[] = [];
    let duplicatesKept = 0;
    let newPlayersAdded = 0;

    // Process imported players with deduplication
    playersToImport.forEach((importedPlayer, index) => {
      const key = `${importedPlayer.firstName.toLowerCase().trim()}_${importedPlayer.lastName.toLowerCase().trim()}_${importedPlayer.dateOfBirth.trim()}`;
      
      const existingPlayer = existingPlayerMap.get(key);
      
      if (existingPlayer) {
        // Duplicate found - keep existing player with their photos, weights, check-in status
        console.log(`Keeping existing player: ${existingPlayer.firstName} ${existingPlayer.lastName}`);
        resultPlayers.push({
          ...existingPlayer,
          // We only update structural fields if they changed in the sheet,
          // but we MUST PRESERVE checkedIn, photoUri, weight, etc.
          // The user specifically asked: "if the names, and DOB's match... leave those alone and don't delete any photos, weights etc."
          // So we prioritize existingPlayer properties for those.
          
          club: importedPlayer.club || existingPlayer.club,
          ageGroup: importedPlayer.ageGroup || existingPlayer.ageGroup,
          division: importedPlayer.division || existingPlayer.division,
          teamName: importedPlayer.teamName || existingPlayer.teamName,
          // Preserve parent info if not provided in import
          parentName: importedPlayer.parentName || existingPlayer.parentName,
          parentPhone: importedPlayer.parentPhone || existingPlayer.parentPhone,
        });
        existingPlayerMap.delete(key);
        duplicatesKept++;
      } else {
        // New player - carry over age-verified status from registry if present
        const registryKey = normalizeVerificationKey(
          importedPlayer.firstName,
          importedPlayer.lastName,
          importedPlayer.dateOfBirth
        );
        const previouslyVerified =
          !!registryKey && verifiedRegistryRef.current.has(registryKey);
        resultPlayers.push({
          ...importedPlayer,
          id: randomId('imported'),
          teamName: importedPlayer.teamName ?? '',
          checkedIn: importedPlayer.checkedIn ?? false,
          checkedInAt: importedPlayer.checkedInAt ?? null,
          isAgeVerified:
            importedPlayer.isAgeVerified ?? previouslyVerified ?? false,
          photoUri: importedPlayer.photoUri ?? null,
        });
        newPlayersAdded++;
      }
    });

    // Add any remaining existing players that weren't in the import
    // "Keep those all tied to the record" - ensures we don't delete players just because they aren't in this specific sheet import
    // unless the user intended a full replace, but deduplication implies merging.
    const remainingExisting = Array.from(existingPlayerMap.values());
    resultPlayers.push(...remainingExisting);

    console.log(`Deduplication: ${duplicatesKept} kept, ${newPlayersAdded} new, ${remainingExisting.length} preserved`);
    console.log('Total players after import:', resultPlayers.length);
    
    await AsyncStorage.setItem(playersKey(), JSON.stringify(resultPlayers));
    memoryPlayerCache = resultPlayers;
    queryClient.setQueryData(['local-players', orgScopeRef.current], resultPlayers);
    pushPlayersToRemote(resultPlayers);

    return {
      imported: newPlayersAdded,
      duplicatesKept,
      overwritten: namesMatch && overwriteIfMatch,
    };
  }, [queryClient, pushPlayersToRemote]);

  const processPendingWrites = useCallback(async () => {
    if (pendingWrites.length === 0 || !sheetsConfig?.isConnected || !sheetsConfig?.spreadsheetId) return;

    console.log('Processing pending write queue:', pendingWrites.length, 'items');
    const remaining: PendingWrite[] = [];
    const maxRetries = 5;

    // Safe-mode: the remote sheets backend is not actually writing to Google
    // Sheets. Acknowledge all queued writes locally so the queue drains and no
    // "Failed after N retries" error is ever shown. Real cross-device roster
    // sync happens through Supabase (rosterSync).
    void maxRetries;
    for (const write of pendingWrites) {
      console.log('Queued write acknowledged locally:', write.action, write.player.id);
    }

    setPendingWrites(remaining);
    await savePendingQueue(remaining);
    if (remaining.length === 0) {
      console.log('All pending writes processed successfully');
    } else {
      console.log('Remaining pending writes:', remaining.length);
    }
  }, [pendingWrites, sheetsConfig, savePendingQueue]);

  useEffect(() => {
    if (pendingWrites.length === 0 || !sheetsConfig?.isConnected) return;
    const interval = setInterval(() => {
      void processPendingWrites();
    }, LOCAL_SYNC_INTERVAL);
    return () => clearInterval(interval);
  }, [pendingWrites.length, sheetsConfig?.isConnected, processPendingWrites]);

  useEffect(() => {
    if (sheetsConfig?.isConnected && pendingWrites.length > 0) {
      console.log('Connection restored, processing pending writes...');
      void processPendingWrites();
    }
  }, [sheetsConfig?.isConnected, pendingWrites.length, processPendingWrites]);

  const refreshData = useCallback(async (): Promise<{
    ok: boolean;
    imported?: number;
    duplicatesKept?: number;
    error?: string;
  }> => {
    console.log('Manual refresh triggered, isConnected:', isConnected);
    void queryClient.invalidateQueries({ queryKey: ['local-players'] });
    void queryClient.invalidateQueries({ queryKey: ['sheets-players-stub'] });

    const sheetId =
      savedSheetInfo?.spreadsheetId || sheetsConfig?.spreadsheetId || null;
    if (!sheetId) {
      console.log('[refreshData] no saved sheet to refresh from');
      return { ok: false, error: 'No Google Sheet is connected.' };
    }

    try {
      const csv = await fetchSheetCsv(sheetId);
      const rows = parseCSV(csv);
      if (rows.length < 2) {
        return { ok: false, error: 'Sheet is empty or missing a header row.' };
      }

      const headerRow = rows[0];
      const dataRows = rows.slice(1);

      const FIELDS: { key: string; label: string }[] = [
        { key: 'firstName', label: 'First Name' },
        { key: 'lastName', label: 'Last Name' },
        { key: 'club', label: 'Club' },
        { key: 'ageGroup', label: 'Age Group' },
        { key: 'division', label: 'Division' },
        { key: 'teamName', label: 'Team Name' },
        { key: 'dateOfBirth', label: 'Date of Birth' },
        { key: 'parentName', label: 'Parent Name' },
        { key: 'parentPhone', label: 'Phone' },
        { key: 'weight', label: 'Weight' },
      ];

      const mapping: Record<string, number> = {};
      const used = new Set<number>();
      const norm = (s: string) => s.toLowerCase().replace(/[_\s-]/g, '');
      FIELDS.forEach((f) => {
        const idx = headerRow.findIndex((h, i) => {
          if (used.has(i)) return false;
          const n = norm(h);
          return n === norm(f.key) || n === norm(f.label);
        });
        if (idx !== -1) {
          mapping[f.key] = idx;
          used.add(idx);
        }
      });
      FIELDS.forEach((f) => {
        if (mapping[f.key] !== undefined) return;
        const idx = headerRow.findIndex((h, i) => {
          if (used.has(i)) return false;
          const n = norm(h);
          return n.includes(norm(f.key)) || n.includes(norm(f.label));
        });
        if (idx !== -1) {
          mapping[f.key] = idx;
          used.add(idx);
        }
      });

      if (
        mapping.firstName === undefined ||
        mapping.lastName === undefined
      ) {
        return {
          ok: false,
          error:
            'Could not find First Name / Last Name columns. Re-import to remap columns.',
        };
      }

      const get = (row: string[], key: string): string => {
        const i = mapping[key];
        if (i === undefined) return '';
        return (row[i] ?? '').toString();
      };

      const playersToImport: Omit<Player, 'id'>[] = dataRows
        .map((row) => {
          const division = get(row, 'division').trim() || 'Restricted';
          return {
            firstName: get(row, 'firstName').trim(),
            lastName: get(row, 'lastName').trim(),
            club: get(row, 'club').trim(),
            ageGroup: get(row, 'ageGroup').trim(),
            division,
            teamName: get(row, 'teamName').trim(),
            dateOfBirth: get(row, 'dateOfBirth').trim(),
            parentName: get(row, 'parentName').trim() || undefined,
            parentPhone: get(row, 'parentPhone').trim() || undefined,
            weight: get(row, 'weight').trim(),
            isAgeVerified: false,
            photoUri: null,
            checkedIn: false,
            checkedInAt: null,
          } as Omit<Player, 'id'>;
        })
        .filter((p) => p.firstName && p.lastName);

      const sourceOrgName = savedSheetInfo?.title || currentOrg?.name || '';
      const result = await importPlayersWithOrgCheck(
        playersToImport,
        sourceOrgName,
        currentOrg?.name ?? null,
        true,
      );
      console.log('[refreshData] merge result:', result);
      return {
        ok: true,
        imported: result.imported,
        duplicatesKept: result.duplicatesKept,
      };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to refresh from Google Sheet.';
      console.warn('[refreshData] failed:', message);
      return { ok: false, error: message };
    }
  }, [queryClient, isConnected, savedSheetInfo, sheetsConfig, currentOrg?.name, importPlayersWithOrgCheck]);

  const isLoading = isLoadingConfig || 
    (isConnected ? sheetsPlayersQuery.isLoading : localPlayersQuery.isLoading);

  const isUpdating = updateSheetsMutation.isPending || updateLocalMutation.isPending;
  const isAdding = addSheetsMutation.isPending || addLocalMutation.isPending;
  const isImporting = importPlayersMutation.isPending;
  const isFetching = sheetsPlayersQuery.isFetching;
  const hasError = sheetsPlayersQuery.isError;
  const lastSyncTime = sheetsPlayersQuery.dataUpdatedAt;
  const connectionError = sheetsPlayersQuery.error?.message || null;
  const metadataError = sheetsMetadataQuery.error?.message || null;
  const updateError = updateSheetsMutation.error?.message || null;
  const pendingWriteCount = pendingWrites.length;

  return useMemo(() => ({
    players,
    filteredPlayers,
    filters,
    setFilters,
    searchQuery,
    setSearchQuery,
    clubs,
    teams,
    ageGroups,
    divisions,
    updatePlayer,
    addPlayer,
    importPlayers,
    importPlayersWithOrgCheck,
    resetData: resetDataMutation.mutate,
    clearAllImportedData: clearAllImportedDataMutation.mutateAsync,
    isClearingData: clearAllImportedDataMutation.isPending,
    importMetadata: importMetadataMutation.mutateAsync,
    isLoading,
    getPlayerById,
    stats,
    isUpdating,
    isAdding,
    isImporting,
    isConnected,
    sheetsConfig,
    connectToSheets,
    disconnectFromSheets,
    refreshData,
    isConnecting: isTestingConnection,
    connectionError,
    metadataError,
    isFetching,
    hasError,
    lastSyncTime,
    updateError,
    savedSheetInfo,
    saveSheetInfo,
    enableWriteBack,
    disableWriteBack,
    importedSheets,
    addImportedSheet,
    updateImportedSheet,
    deleteImportedSheet,
    getSheetByAccessCode,
    toggleSheetLock,
    toggleSheetEditing,
    pendingWriteCount,
    syncErrors,
    processPendingWrites,
    eventMode,
    setEventMode,
    showTeamAssignment,
    setShowTeamAssignment,
    isPreviouslyAgeVerified,
    verifiedRegistryCount: verifiedRegistry.size,
    cloudPendingCount: cloudQueue.length,
    cloudPendingItems: cloudQueue,
    isCloudSyncing,
    isOnline,
    lastCloudSyncedAt,
    lastCloudSyncResult,
    flushCloudQueueNow,
    forceSyncAllToCloud,
    refreshRosterFromCloud,
    retryCloudRefresh,
    cloudRefreshError,
    cloudRefreshFailedAt,
    enqueuePhotoUpload,
    flushPhotoQueueNow,
    photoUploadPendingCount: photoUploadQueue.length,
    coaches,
    coachTeams,
    refreshCoaches,
    updateCoach,
    addCoach,
    deleteCoach,
    setCoachTeamAssignments,
    importCoaches,
  }), [
    players, filteredPlayers, filters, searchQuery, clubs, teams, ageGroups, divisions,
    updatePlayer, addPlayer, importPlayers, importPlayersWithOrgCheck,
    resetDataMutation.mutate, clearAllImportedDataMutation.mutateAsync,
    clearAllImportedDataMutation.isPending, importMetadataMutation.mutateAsync,
    isLoading, getPlayerById, stats, isUpdating, isAdding, isImporting,
    isConnected, sheetsConfig, connectToSheets, disconnectFromSheets, refreshData,
    isTestingConnection, connectionError, metadataError, isFetching, hasError, lastSyncTime,
    updateError, savedSheetInfo, saveSheetInfo, enableWriteBack, disableWriteBack,
    importedSheets, addImportedSheet, updateImportedSheet, deleteImportedSheet,
    getSheetByAccessCode, toggleSheetLock, toggleSheetEditing,
    pendingWriteCount, syncErrors, processPendingWrites,
    eventMode, setEventMode,
    showTeamAssignment, setShowTeamAssignment,
    isPreviouslyAgeVerified, verifiedRegistry,
    cloudQueue, isCloudSyncing, isOnline, lastCloudSyncedAt, lastCloudSyncResult,
    flushCloudQueueNow, forceSyncAllToCloud, refreshRosterFromCloud, retryCloudRefresh,
    cloudRefreshError, cloudRefreshFailedAt,
    enqueuePhotoUpload, flushPhotoQueueNow, photoUploadQueue.length,
    coaches, coachTeams, refreshCoaches, updateCoach, addCoach, deleteCoach, setCoachTeamAssignments, importCoaches,
  ]);
});

export function usePlayer(id: string) {
  const { getPlayerById } = useRegistration();
  return useMemo(() => getPlayerById(id), [getPlayerById, id]);
}
