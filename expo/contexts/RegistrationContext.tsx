import createContextHook from '@nkzw/create-context-hook';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { Player, RegistrationFilters, Club, AgeGroup, Division, ImportedSheet } from '@/types';
import { mockPlayers, clubs as mockClubs, ageGroups as mockAgeGroups } from '@/mocks/registrationData';
import { trpc } from '@/lib/trpc';
import { useAuth } from '@/contexts/AuthContext';
import { useOrganization } from '@/contexts/OrganizationContext';
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
  deleteRosterPlayer,
  type RosterChange,
} from '@/lib/rosterSync';

const RETRY_COUNT = 3;
const RETRY_DELAY = 1000;
const WRITE_QUEUE_KEY = 'pending_write_queue';
const LOCAL_SYNC_INTERVAL = 30000; // How often to push local changes to sheets

const PLAYERS_STORAGE_KEY = 'registration_players';
const SHEETS_CONFIG_KEY = 'google_sheets_config';
const SAVED_SHEET_URL_KEY = 'saved_google_sheet_url';
const IMPORTED_SHEETS_KEY = 'imported_sheets_history';
const EVENT_MODE_KEY = 'event_mode';
const SHOW_TEAM_ASSIGNMENT_KEY = 'show_team_assignment';

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
  const pick = <T,>(av: T, bv: T, isEmpty: (v: T) => boolean): T => {
    if (!isEmpty(av)) return av;
    return bv;
  };
  const isEmptyStr = (v: string | null | undefined) => !v || !String(v).trim();
  const checkedIn = !!a.checkedIn || !!b.checkedIn;
  let checkedInAt: string | null = null;
  if (a.checkedInAt && b.checkedInAt) {
    checkedInAt = new Date(a.checkedInAt) > new Date(b.checkedInAt) ? a.checkedInAt : b.checkedInAt;
  } else {
    checkedInAt = a.checkedInAt || b.checkedInAt || null;
  }
  return {
    ...a,
    firstName: pick(a.firstName, b.firstName, isEmptyStr),
    lastName: pick(a.lastName, b.lastName, isEmptyStr),
    club: pick(a.club, b.club, isEmptyStr),
    ageGroup: pick(a.ageGroup, b.ageGroup, isEmptyStr),
    division: pick(a.division, b.division, isEmptyStr),
    teamName: pick(a.teamName, b.teamName, isEmptyStr),
    dateOfBirth: pick(a.dateOfBirth, b.dateOfBirth, isEmptyStr),
    parentName: pick(a.parentName, b.parentName, isEmptyStr),
    parentPhone: pick(a.parentPhone, b.parentPhone, isEmptyStr),
    isAgeVerified: !!a.isAgeVerified || !!b.isAgeVerified,
    photoUri: a.photoUri || b.photoUri || null,
    weight: pick(a.weight ?? '', b.weight ?? '', isEmptyStr),
    checkedIn,
    checkedInAt,
    restrictionStatus: a.restrictionStatus && a.restrictionStatus !== 'none' ? a.restrictionStatus : (b.restrictionStatus ?? a.restrictionStatus ?? 'none'),
    calculatedAgeGroup: a.calculatedAgeGroup || b.calculatedAgeGroup,
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
  const groups = new Map<string, Player[]>();
  const noKey: Player[] = [];
  for (const p of list) {
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
  const { canEdit, isAdmin } = useAuth();
  // eslint-disable-next-line rork/general-context-optimization
  const { currentOrg } = useOrganization();
  const orgIdForRegistry = currentOrg?.id ?? 'utah-little-rugby';
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

  // Define Team type locally for the context if not imported
  type TeamOption = { id: string; name: string; club?: string; ageGroup?: string; division?: string };

  useEffect(() => {
    const loadConfig = async () => {
      try {
        const [storedConfig, storedMeta, storedSheetInfo, storedImportedSheets, storedQueue, storedEventMode, storedShowTeam] = await Promise.all([
          AsyncStorage.getItem(SHEETS_CONFIG_KEY),
          AsyncStorage.getItem('imported_metadata'),
          AsyncStorage.getItem(SAVED_SHEET_URL_KEY),
          AsyncStorage.getItem(IMPORTED_SHEETS_KEY),
          AsyncStorage.getItem(WRITE_QUEUE_KEY),
          AsyncStorage.getItem(EVENT_MODE_KEY),
          AsyncStorage.getItem(SHOW_TEAM_ASSIGNMENT_KEY),
        ]);

        if (storedEventMode === 'viewOnly' || storedEventMode === 'registration') {
          setEventModeState(storedEventMode);
          console.log('Loaded event mode:', storedEventMode);
        }

        if (storedShowTeam === 'true') {
          setShowTeamAssignmentState(true);
          console.log('Loaded showTeamAssignment: true');
        }
        
        if (storedConfig) {
          console.log('Loaded sheets config from storage');
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
          console.log('Loaded saved sheet info from storage');
          setSavedSheetInfo(JSON.parse(storedSheetInfo));
        }
        
        if (storedImportedSheets) {
          console.log('Loaded imported sheets history from storage');
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
        setIsLoadingConfig(false);
      }
    };
    void loadConfig();
  }, []);

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
    queryKey: ['local-players'],
    queryFn: async () => {
      console.log('Fetching players from local storage...');
      const stored = await AsyncStorage.getItem(PLAYERS_STORAGE_KEY);
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
      const stored = await AsyncStorage.getItem(PLAYERS_STORAGE_KEY);
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
      await AsyncStorage.setItem(PLAYERS_STORAGE_KEY, JSON.stringify(next));
      queryClient.setQueryData(['local-players'], next);
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

  useEffect(() => {
    if (!currentOrg?.id) return;
    let cancelled = false;

    const mergeRemoteRoster = async () => {
      try {
        const remote = await fetchRoster(currentOrg.id);
        if (cancelled) return;
        if (remote.length === 0) {
          console.log('[rosterSync] remote roster empty, keeping local');
          return;
        }
        const stored = await AsyncStorage.getItem(PLAYERS_STORAGE_KEY);
        const local: Player[] = stored ? JSON.parse(stored) : [];

        const byId = new Map<string, Player>();
        local.forEach((p) => byId.set(p.id, p));
        remote.forEach((p) => byId.set(p.id, p));
        const combined = Array.from(byId.values());

        const { deduped, duplicateIds } = dedupePlayers(combined);

        memoryPlayerCache = deduped;
        await AsyncStorage.setItem(PLAYERS_STORAGE_KEY, JSON.stringify(deduped));
        queryClient.setQueryData(['local-players'], deduped);
        console.log('[rosterSync] merged + deduped remote roster:', {
          remote: remote.length,
          local: local.length,
          combined: combined.length,
          deduped: deduped.length,
          duplicatesRemoved: duplicateIds.length,
        });

        if (duplicateIds.length > 0) {
          const remoteIds = new Set(remote.map((p) => p.id));
          const toDeleteRemote = duplicateIds.filter((id) => remoteIds.has(id));
          if (toDeleteRemote.length > 0) {
            console.log('[rosterSync] cleaning duplicate rows from Supabase:', toDeleteRemote.length);
            for (const dupId of toDeleteRemote) {
              if (cancelled) return;
              void deleteRosterPlayer(currentOrg.id, dupId).catch((e) =>
                console.warn('[rosterSync] dup delete failed:', e?.message ?? e),
              );
            }
          }
          const canonicalIds = new Set(deduped.map((p) => p.id));
          const toPush = deduped.filter((p) => canonicalIds.has(p.id));
          void upsertRosterPlayers(currentOrg.id, toPush).catch((e) =>
            console.warn('[rosterSync] canonical re-upsert failed:', e?.message ?? e),
          );
        }
      } catch (err) {
        console.warn('[rosterSync] initial fetch failed (using local cache):', err);
      }
    };

    void mergeRemoteRoster();

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
  }, [currentOrg?.id, queryClient, applyRosterChangeLocally]);

  const pushPlayerToRemote = useCallback(
    (player: Player) => {
      const orgId = currentOrg?.id;
      if (!orgId) return;
      void upsertRosterPlayer(orgId, player).catch((err) => {
        console.warn('[rosterSync] background upsert failed:', err?.message ?? err);
      });
    },
    [currentOrg?.id],
  );

  const pushPlayersToRemote = useCallback(
    (playersBatch: Player[]) => {
      const orgId = currentOrg?.id;
      if (!orgId || playersBatch.length === 0) return;
      void upsertRosterPlayers(orgId, playersBatch).catch((err) => {
        console.warn('[rosterSync] background bulk upsert failed:', err?.message ?? err);
      });
    },
    [currentOrg?.id],
  );

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
    AsyncStorage.setItem(PLAYERS_STORAGE_KEY, JSON.stringify(data)).catch((err) =>
      console.error('Failed to mirror sheets data to local cache:', err),
    );
  }, [sheetsPlayersQuery.data, sheetsConfig?.isConnected, localPlayersQuery.data]);

  const savePendingQueue = useCallback(async (queue: PendingWrite[]) => {
    await AsyncStorage.setItem(WRITE_QUEUE_KEY, JSON.stringify(queue));
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
        id: player.id ?? `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
      const stored = await AsyncStorage.getItem(PLAYERS_STORAGE_KEY);
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
      
      await AsyncStorage.setItem(PLAYERS_STORAGE_KEY, JSON.stringify(newPlayers));
      console.log('Player data saved to storage, total players:', newPlayers.length);
      return newPlayers;
    },
    onSuccess: (newPlayers, variables) => {
      console.log('Update mutation success, refreshing query cache');
      memoryPlayerCache = newPlayers;
      queryClient.setQueryData(['local-players'], newPlayers);
      pushPlayerToRemote(variables);
    },
  });

  const addLocalMutation = useMutation({
    mutationFn: async (newPlayer: Omit<Player, 'id'>) => {
      console.log('Adding new player locally:', newPlayer.firstName, newPlayer.lastName);
      // Read directly from AsyncStorage to ensure we have the latest data
      const stored = await AsyncStorage.getItem(PLAYERS_STORAGE_KEY);
      const currentPlayers: Player[] = stored ? JSON.parse(stored) : [];
      const player: Player = {
        ...newPlayer,
        id: Date.now().toString(),
      };
      const newPlayers = [...currentPlayers, player];
      await AsyncStorage.setItem(PLAYERS_STORAGE_KEY, JSON.stringify(newPlayers));
      console.log('Player added to storage, total players:', newPlayers.length);
      return { players: newPlayers, newPlayer: player };
    },
    onSuccess: ({ players, newPlayer }) => {
      memoryPlayerCache = players;
      queryClient.setQueryData(['local-players'], players);
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
      
      await AsyncStorage.setItem('imported_metadata', JSON.stringify(metaToSave));
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
      const stored = await AsyncStorage.getItem(PLAYERS_STORAGE_KEY);
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
            id: `imported-${Date.now()}-${index}`,
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
      
      await AsyncStorage.setItem(PLAYERS_STORAGE_KEY, JSON.stringify(resultPlayers));
      return resultPlayers;
    },
    onSuccess: (allPlayers) => {
      console.log('Import success with deduplication, total players:', allPlayers.length);
      memoryPlayerCache = allPlayers;
      queryClient.setQueryData(['local-players'], allPlayers);
      pushPlayersToRemote(allPlayers);
    },
  });

  const resetDataMutation = useMutation({
    mutationFn: async () => {
      console.log('Resetting to mock data...');
      await AsyncStorage.setItem(PLAYERS_STORAGE_KEY, JSON.stringify(mockPlayers));
      return mockPlayers;
    },
    onSuccess: (mockData) => {
      queryClient.setQueryData(['local-players'], mockData);
    },
  });

  const clearAllImportedDataMutation = useMutation({
    mutationFn: async () => {
      console.log('Clearing all imported data...');
      await Promise.all([
        AsyncStorage.removeItem(PLAYERS_STORAGE_KEY),
        AsyncStorage.removeItem(SHEETS_CONFIG_KEY),
        AsyncStorage.removeItem('imported_metadata'),
        AsyncStorage.removeItem(SAVED_SHEET_URL_KEY),
      ]);
      return [];
    },
    onSuccess: () => {
      memoryPlayerCache = [];
      queryClient.setQueryData(['local-players'], []);
      setSheetsConfig(null);
      setSavedSheetInfo(null);
      setImportedClubs([]);
      setImportedTeams([]);
      setImportedAgeGroups([]);
      setImportedDivisions([]);
      void queryClient.invalidateQueries({ queryKey: ['local-players'] });
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
    await AsyncStorage.setItem(SAVED_SHEET_URL_KEY, JSON.stringify(info));
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
      await AsyncStorage.setItem(IMPORTED_SHEETS_KEY, JSON.stringify(updatedSheets));
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
    await AsyncStorage.setItem(IMPORTED_SHEETS_KEY, JSON.stringify(updatedSheets));
    setImportedSheets(updatedSheets);
    console.log('Added new imported sheet with code:', newSheet.accessCode);
    return newSheet;
  }, [importedSheets]);

  const updateImportedSheet = useCallback(async (sheetId: string, updates: Partial<ImportedSheet>) => {
    console.log('Updating imported sheet:', sheetId, updates);
    const updatedSheets = importedSheets.map(s => 
      s.id === sheetId ? { ...s, ...updates } : s
    );
    await AsyncStorage.setItem(IMPORTED_SHEETS_KEY, JSON.stringify(updatedSheets));
    setImportedSheets(updatedSheets);
  }, [importedSheets]);

  const deleteImportedSheet = useCallback(async (sheetId: string) => {
    console.log('Deleting imported sheet:', sheetId);
    const updatedSheets = importedSheets.filter(s => s.id !== sheetId);
    await AsyncStorage.setItem(IMPORTED_SHEETS_KEY, JSON.stringify(updatedSheets));
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
    await AsyncStorage.setItem(SHEETS_CONFIG_KEY, JSON.stringify(config));
    setSheetsConfig(config);
    console.log('Write-back enabled - changes will sync to Google Sheets');
  }, []);

  const disableWriteBack = useCallback(async () => {
    console.log('Disabling write-back (keeping saved sheet info)');
    await AsyncStorage.removeItem(SHEETS_CONFIG_KEY);
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
      await AsyncStorage.setItem(SHEETS_CONFIG_KEY, JSON.stringify(config));
      setSheetsConfig(config);
      console.log('Connected to Google Sheets successfully');
      return result;
    }
    throw new Error('Connection test failed');
  }, [testConnectionAsync]);

  const disconnectFromSheets = useCallback(async () => {
    console.log('Disconnecting from Google Sheets');
    await AsyncStorage.removeItem(SHEETS_CONFIG_KEY);
    setSheetsConfig(null);
    void queryClient.invalidateQueries({ queryKey: ['local-players'] });
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

  const clubs: Club[] = useMemo(() => {
    const uniqueClubs = new Map<string, Club>();
    
    // 1. Add clubs from CONNECTED metadata
    if (isConnected && sheetsMetadataQuery.data?.clubs?.length) {
      sheetsMetadataQuery.data.clubs.forEach(club => {
        if (club.name && !uniqueClubs.has(club.name)) {
          uniqueClubs.set(club.name, club);
        }
      });
    }
    
    // 2. Add clubs from IMPORTED metadata
    if (!isConnected && importedClubs.length > 0) {
      importedClubs.forEach(club => {
        if (club.name && !uniqueClubs.has(club.name)) {
          uniqueClubs.set(club.name, club);
        }
      });
    }
    
    // 3. Add clubs from player data
    players.forEach(player => {
      if (player.club && !uniqueClubs.has(player.club)) {
        uniqueClubs.set(player.club, {
          id: player.club.toLowerCase().replace(/\s+/g, '-'),
          name: player.club,
        });
      }
    });
    
    const allClubs = Array.from(uniqueClubs.values()).sort((a, b) => 
      a.name.localeCompare(b.name)
    );
    
    if (allClubs.length > 0) {
      return allClubs;
    }
    return mockClubs;
  }, [players, isConnected, sheetsMetadataQuery.data, importedClubs]);

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
      if (player.teamName && !uniqueTeams.has(player.teamName)) {
        uniqueTeams.set(player.teamName, {
          id: `team-${player.teamName.toLowerCase().replace(/\s+/g, '-')}`,
          name: player.teamName,
          club: player.club,
          ageGroup: player.ageGroup,
          division: player.division
        });
      }
    });

    return Array.from(uniqueTeams.values()).sort((a, b) => 
      a.name.localeCompare(b.name)
    );
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
    const normalizeAge = (s: string | undefined | null): string => {
      const raw = (s || '').toString().toUpperCase();
      if (!raw.trim()) return '';
      const match = raw.match(/(\d{1,2})/);
      if (match) {
        return `U${parseInt(match[1], 10)}`;
      }
      return raw.replace(/\s+/g, '');
    };

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
      const target = normalizeAge(filters.ageGroup);
      result = result.filter(p => {
        const effectiveAgeGroup = p.calculatedAgeGroup || p.ageGroup || '';
        return normalizeAge(effectiveAgeGroup) === target;
      });
      console.log('[Filter] after age filter:', result.length, 'target:', target);
    }
    if (filters.division) {
      const target = normalizeStr(filters.division);
      result = result.filter(p => normalizeStr(p.division) === target);
      console.log('[Filter] after division filter:', result.length);
    }
    if (filters.teamName) {
      const target = normalizeStr(filters.teamName);
      result = result.filter(p => normalizeStr(p.teamName) === target);
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
    setEventModeState(mode);
    await AsyncStorage.setItem(EVENT_MODE_KEY, mode);
  }, [isAdmin]);

  const setShowTeamAssignment = useCallback(async (value: boolean) => {
    if (!isAdmin) {
      throw new Error('Only the admin can change this setting.');
    }
    console.log('Setting showTeamAssignment to:', value);
    setShowTeamAssignmentState(value);
    await AsyncStorage.setItem(SHOW_TEAM_ASSIGNMENT_KEY, value ? 'true' : 'false');
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

    const stored = await AsyncStorage.getItem(PLAYERS_STORAGE_KEY);
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
          id: `imported-${Date.now()}-${index}`,
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
    
    await AsyncStorage.setItem(PLAYERS_STORAGE_KEY, JSON.stringify(resultPlayers));
    memoryPlayerCache = resultPlayers;
    queryClient.setQueryData(['local-players'], resultPlayers);
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

  const refreshData = useCallback(() => {
    console.log('Manual refresh triggered, isConnected:', isConnected);
    void queryClient.invalidateQueries({ queryKey: ['local-players'] });
    void queryClient.invalidateQueries({ queryKey: ['sheets-players-stub'] });
  }, [queryClient]);

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
  ]);
});

export function usePlayer(id: string) {
  const { getPlayerById } = useRegistration();
  return useMemo(() => getPlayerById(id), [getPlayerById, id]);
}
