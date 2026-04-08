import createContextHook from '@nkzw/create-context-hook';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useMemo, useCallback, useEffect, } from 'react';
import { supabase } from '@/lib/supabase';
import {
  Organization,
  Team,
  Event,
  EventTeam,
  OpponentVerification,
  OrgMember,
  UserOrgRole,
  EventCheckIn,
  OrgPrivacySettings,
  VerificationPass,
  VerificationView,
  OfflineCheckIn,
  LimitedPlayerData,
  Player,
} from '@/types';
import NetInfo from '@react-native-community/netinfo';

const ORG_STORAGE_KEY = 'organizations_data';
const CURRENT_ORG_KEY = 'current_org_id';
const CURRENT_EVENT_KEY = 'current_event_id';
const OFFLINE_QUEUE_KEY = 'offline_checkin_queue';

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function generateUUID(): string {
  // Generate a proper UUID v4 format for Supabase compatibility
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function generateOrgCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

interface OrgData {
  organizations: Organization[];
  teams: Team[];
  events: Event[];
  eventTeams: EventTeam[];
  members: OrgMember[];
  verifications: OpponentVerification[];
  checkIns: EventCheckIn[];
  privacySettings: OrgPrivacySettings[];
  verificationPasses: VerificationPass[];
  verificationViews: VerificationView[];
}

const DEFAULT_ORG_DATA: OrgData = {
  organizations: [],
  teams: [],
  events: [],
  eventTeams: [],
  members: [],
  verifications: [],
  checkIns: [],
  privacySettings: [],
  verificationPasses: [],
  verificationViews: [],
};

function generateVerificationCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function hashToken(token: string): string {
  let hash = 0;
  for (let i = 0; i < token.length; i++) {
    const char = token.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

const DEFAULT_PRIVACY_SETTINGS: Omit<OrgPrivacySettings, 'id' | 'orgId' | 'updatedAt'> = {
  showFullName: false,
  showJerseyNumber: true,
  showBirthYear: true,
  showPhoto: false,
  showWeight: false,
  verificationPassDurationMinutes: 240,
};

export const [OrganizationProvider, useOrganization] = createContextHook(() => {
  const queryClient = useQueryClient();
  const [currentOrgId, setCurrentOrgId] = useState<string | null>(null);
  const [currentEventId, setCurrentEventId] = useState<string | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [offlineQueue, setOfflineQueue] = useState<OfflineCheckIn[]>([]);

  useEffect(() => {
    const loadCurrentSelections = async () => {
      try {
        const [orgId, eventId, queueData] = await Promise.all([
          AsyncStorage.getItem(CURRENT_ORG_KEY),
          AsyncStorage.getItem(CURRENT_EVENT_KEY),
          AsyncStorage.getItem(OFFLINE_QUEUE_KEY),
        ]);
        if (orgId) setCurrentOrgId(orgId);
        if (eventId) setCurrentEventId(eventId);
        if (queueData) setOfflineQueue(JSON.parse(queueData));
        console.log('Loaded org selections:', { orgId, eventId });
      } catch (error) {
        console.error('Failed to load org selections:', error);
      } finally {
        setIsInitialized(true);
      }
    };
    void loadCurrentSelections();
  }, []);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => {
      const online = state.isConnected ?? true;
      console.log('Network status changed:', online ? 'online' : 'offline');
      setIsOnline(online);
    });
    return () => unsubscribe();
  }, []);

  const orgDataQuery = useQuery({
    queryKey: ['org-data'],
    queryFn: async () => {
      console.log('Loading organization data from storage...');
      const stored = await AsyncStorage.getItem(ORG_STORAGE_KEY);
      if (stored) {
        console.log('Found stored org data');
        return JSON.parse(stored) as OrgData;
      }
      console.log('No stored org data, using defaults');
      return DEFAULT_ORG_DATA;
    },
  });

  const saveDataMutation = useMutation({
    mutationFn: async (data: OrgData) => {
      await AsyncStorage.setItem(ORG_STORAGE_KEY, JSON.stringify(data));
      return data;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['org-data'], data);
    },
  });

  const { mutateAsync: saveData, isPending: isSaving } = saveDataMutation;

  const orgData = orgDataQuery.data || DEFAULT_ORG_DATA;

  const currentOrg = useMemo(() => {
    if (!currentOrgId) return null;
    return orgData.organizations.find(o => o.id === currentOrgId) || null;
  }, [currentOrgId, orgData.organizations]);

  const currentEvent = useMemo(() => {
    if (!currentEventId) return null;
    return orgData.events.find(e => e.id === currentEventId) || null;
  }, [currentEventId, orgData.events]);

  const currentOrgTeams = useMemo(() => {
    if (!currentOrgId) return [];
    return orgData.teams.filter(t => t.orgId === currentOrgId);
  }, [currentOrgId, orgData.teams]);

  const currentOrgEvents = useMemo(() => {
    if (!currentOrgId) return [];
    return orgData.events.filter(e => e.orgId === currentOrgId);
  }, [currentOrgId, orgData.events]);

  const currentEventTeams = useMemo(() => {
    if (!currentEventId) return [];
    return orgData.eventTeams.filter(et => et.eventId === currentEventId);
  }, [currentEventId, orgData.eventTeams]);

  const currentEventVerifications = useMemo(() => {
    if (!currentEventId) return [];
    return orgData.verifications.filter(v => v.eventId === currentEventId);
  }, [currentEventId, orgData.verifications]);

  const selectOrg = useCallback(async (orgId: string | null) => {
    console.log('Selecting org:', orgId);
    setCurrentOrgId(orgId);
    if (orgId) {
      await AsyncStorage.setItem(CURRENT_ORG_KEY, orgId);
    } else {
      await AsyncStorage.removeItem(CURRENT_ORG_KEY);
    }
    setCurrentEventId(null);
    await AsyncStorage.removeItem(CURRENT_EVENT_KEY);
  }, []);

  const selectEvent = useCallback(async (eventId: string | null) => {
    console.log('Selecting event:', eventId);
    setCurrentEventId(eventId);
    if (eventId) {
      await AsyncStorage.setItem(CURRENT_EVENT_KEY, eventId);
    } else {
      await AsyncStorage.removeItem(CURRENT_EVENT_KEY);
    }
  }, []);

  const createOrg = useCallback(async (name: string, ownerId: string, primaryColor?: string): Promise<Organization> => {
    console.log('Creating organization:', name);
    const orgCode = generateOrgCode();
    // Use UUID format for Supabase compatibility
    const orgId = generateUUID();
    const ownerUUID = generateUUID();
    
    console.log('Generated org ID (UUID):', orgId);
    console.log('Generated org code:', orgCode);
    
    // Try to save to Supabase first
    let savedToSupabase = false;
    try {
      const { data: supabaseOrg, error } = await supabase
        .from('organizations')
        .insert({
          id: orgId,
          name,
          code: orgCode,
          logo_uri: null,
          primary_color: primaryColor || '#0B7A4B',
          owner_id: ownerUUID,
          expires_at: expiresAt.toISOString(),
        })
        .select()
        .single();
      
      if (error) {
        console.error('Failed to save org to Supabase:', error.message, error.code, error.details);
      } else {
        console.log('Organization saved to Supabase successfully:', supabaseOrg.id);
        savedToSupabase = true;
        
        // Also save owner member to Supabase
        const { error: memberError } = await supabase
          .from('org_members')
          .insert({
            org_id: orgId,
            user_id: ownerUUID,
            role: 'owner',
            email: '',
            name: 'Owner',
          });
        
        if (memberError) {
          console.warn('Failed to save owner member to Supabase:', memberError.message);
        } else {
          console.log('Owner member saved to Supabase');
        }
      }
    } catch (err) {
      console.error('Supabase error during org creation:', err);
    }
    
    if (!savedToSupabase) {
      console.warn('Organization NOT saved to Supabase - join codes will only work on this device');
    }
    
    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + 4);

    const org: Organization = {
      id: orgId,
      name,
      code: orgCode,
      logoUri: null,
      primaryColor: primaryColor || '#0B7A4B',
      createdAt: new Date().toISOString(),
      ownerId: ownerUUID,
      expiresAt: expiresAt.toISOString(),
    };

    const ownerMember: OrgMember = {
      id: generateUUID(),
      orgId: org.id,
      userId: ownerUUID,
      role: 'owner',
      email: '',
      name: 'Owner',
      joinedAt: new Date().toISOString(),
    };

    const newData: OrgData = {
      ...orgData,
      organizations: [...orgData.organizations, org],
      members: [...orgData.members, ownerMember],
    };

    await saveData(newData);
    await selectOrg(org.id);
    return org;
  }, [orgData, saveData, selectOrg]);

  const updateOrg = useCallback(async (org: Organization) => {
    console.log('Updating organization:', org.id);
    const newData: OrgData = {
      ...orgData,
      organizations: orgData.organizations.map(o => o.id === org.id ? org : o),
    };
    await saveData(newData);
  }, [orgData, saveData]);

  const joinOrgByCode = useCallback(async (code: string, userId: string, userName: string, email: string): Promise<Organization | null> => {
    console.log('Joining org by code:', code);
    const normalizedCode = code.toUpperCase().trim();
    
    // First check local storage
    let org = orgData.organizations.find(o => o.code.toUpperCase() === normalizedCode);
    console.log('Local lookup result:', org ? `Found: ${org.name}` : 'Not found locally');
    
    // If not found locally, try to fetch from Supabase
    if (!org) {
      console.log('Organization not found locally, checking Supabase...');
      try {
        // Use maybeSingle() instead of single() to avoid errors when no row is found
        const { data: supabaseOrg, error } = await supabase
          .from('organizations')
          .select('*')
          .ilike('code', normalizedCode)
          .maybeSingle();
        
        if (error) {
          console.log('Supabase lookup error:', error.code, error.message);
          // Don't fail completely - the org might still be local-only
        } else if (supabaseOrg) {
          console.log('Found organization in Supabase:', supabaseOrg.name, 'ID:', supabaseOrg.id);
          // Convert Supabase format to local format
          const fallbackExpiry = new Date(supabaseOrg.created_at);
          fallbackExpiry.setMonth(fallbackExpiry.getMonth() + 4);
          org = {
            id: supabaseOrg.id,
            name: supabaseOrg.name,
            code: supabaseOrg.code,
            logoUri: supabaseOrg.logo_uri,
            primaryColor: supabaseOrg.primary_color || '#0B7A4B',
            createdAt: supabaseOrg.created_at,
            ownerId: supabaseOrg.owner_id,
            expiresAt: supabaseOrg.expires_at || fallbackExpiry.toISOString(),
          };
        } else {
          console.log('No organization found in Supabase with code:', normalizedCode);
        }
      } catch (err) {
        console.log('Supabase request failed:', err);
      }
    }
    
    if (!org) {
      console.log('Organization not found with code:', code);
      return null;
    }

    // Check if already a member locally
    const existingMember = orgData.members.find(m => m.orgId === org!.id && m.userId === userId);
    if (existingMember) {
      console.log('Already a member of this organization');
      // Make sure org is in local storage
      if (!orgData.organizations.find(o => o.id === org!.id)) {
        const newData: OrgData = {
          ...orgData,
          organizations: [...orgData.organizations, org!],
        };
        await saveData(newData);
      }
      await selectOrg(org.id);
      return org;
    }

    const member: OrgMember = {
      id: generateUUID(),
      orgId: org.id,
      userId,
      role: 'volunteer',
      email,
      name: userName,
      joinedAt: new Date().toISOString(),
    };
    
    // Try to save member to Supabase
    try {
      const { error } = await supabase
        .from('org_members')
        .insert({
          org_id: org.id,
          user_id: userId,
          role: 'volunteer',
          email,
          name: userName,
        });
      
      if (error) {
        console.warn('Failed to save member to Supabase:', error.message);
      } else {
        console.log('Member saved to Supabase');
      }
    } catch (err) {
      console.warn('Supabase not available for member save:', err);
    }

    // Save locally - include org if it wasn't there before
    const orgsToSave = orgData.organizations.find(o => o.id === org!.id)
      ? orgData.organizations
      : [...orgData.organizations, org!];
    
    const newData: OrgData = {
      ...orgData,
      organizations: orgsToSave,
      members: [...orgData.members, member],
    };

    await saveData(newData);
    await selectOrg(org.id);
    return org;
  }, [orgData, saveData, selectOrg]);

  const createTeam = useCallback(async (team: Omit<Team, 'id' | 'createdAt'>): Promise<Team> => {
    console.log('Creating team:', team.name);
    const newTeam: Team = {
      ...team,
      id: generateId(),
      createdAt: new Date().toISOString(),
    };

    const newData: OrgData = {
      ...orgData,
      teams: [...orgData.teams, newTeam],
    };

    await saveData(newData);
    return newTeam;
  }, [orgData, saveData]);

  const createTeamsBulk = useCallback(async (teams: Omit<Team, 'id' | 'createdAt'>[]): Promise<Team[]> => {
    console.log('Creating teams in bulk:', teams.length);
    const newTeams: Team[] = teams.map(team => ({
      ...team,
      id: generateId(),
      createdAt: new Date().toISOString(),
    }));

    const newData: OrgData = {
      ...orgData,
      teams: [...orgData.teams, ...newTeams],
    };

    await saveData(newData);
    return newTeams;
  }, [orgData, saveData]);

  const clearOrgTeams = useCallback(async (orgId: string): Promise<void> => {
    console.log('Clearing all teams for org:', orgId);
    const newData: OrgData = {
      ...orgData,
      teams: orgData.teams.filter(t => t.orgId !== orgId),
      eventTeams: orgData.eventTeams.filter(et => {
        const team = orgData.teams.find(t => t.id === et.teamId);
        return team?.orgId !== orgId;
      }),
    };
    await saveData(newData);
  }, [orgData, saveData]);

  const getOrgByName = useCallback((name: string): Organization | null => {
    return orgData.organizations.find(
      o => o.name.toLowerCase().trim() === name.toLowerCase().trim()
    ) || null;
  }, [orgData.organizations]);

  const shouldOverwriteOrgData = useCallback((targetOrgName: string, currentOrgId: string | null): boolean => {
    if (!currentOrgId) return false;
    const currentOrg = orgData.organizations.find(o => o.id === currentOrgId);
    if (!currentOrg) return false;
    
    const namesMatch = currentOrg.name.toLowerCase().trim() === targetOrgName.toLowerCase().trim();
    console.log('Checking org name match:', { currentOrg: currentOrg.name, targetOrgName, matches: namesMatch });
    return namesMatch;
  }, [orgData.organizations]);

  const importTeamsWithOrgCheck = useCallback(async (
    teams: Omit<Team, 'id' | 'createdAt'>[],
    sourceOrgName: string,
    overwriteIfMatch: boolean = true
  ): Promise<{ imported: number; skipped: number; overwritten: boolean }> => {
    console.log('Importing teams with org check:', { teamCount: teams.length, sourceOrgName, overwriteIfMatch });
    
    if (!currentOrgId) {
      console.log('No current org selected, skipping import');
      return { imported: 0, skipped: teams.length, overwritten: false };
    }

    const shouldOverwrite = shouldOverwriteOrgData(sourceOrgName, currentOrgId);
    console.log('Should overwrite:', shouldOverwrite);

    if (overwriteIfMatch && shouldOverwrite) {
      console.log('Overwriting existing teams for matching org');
      await clearOrgTeams(currentOrgId);
    }

    const newTeams: Team[] = teams.map(team => ({
      ...team,
      orgId: currentOrgId,
      id: generateId(),
      createdAt: new Date().toISOString(),
    }));

    const newData: OrgData = {
      ...orgData,
      teams: [...orgData.teams.filter(t => t.orgId !== currentOrgId || !shouldOverwrite), ...newTeams],
    };

    await saveData(newData);
    return { imported: newTeams.length, skipped: 0, overwritten: shouldOverwrite };
  }, [currentOrgId, orgData, saveData, shouldOverwriteOrgData, clearOrgTeams]);

  const updateTeam = useCallback(async (team: Team) => {
    console.log('Updating team:', team.id);
    const newData: OrgData = {
      ...orgData,
      teams: orgData.teams.map(t => t.id === team.id ? team : t),
    };
    await saveData(newData);
  }, [orgData, saveData]);

  const deleteTeam = useCallback(async (teamId: string) => {
    console.log('Deleting team:', teamId);
    const newData: OrgData = {
      ...orgData,
      teams: orgData.teams.filter(t => t.id !== teamId),
      eventTeams: orgData.eventTeams.filter(et => et.teamId !== teamId),
    };
    await saveData(newData);
  }, [orgData, saveData]);

  const deleteOrg = useCallback(async (orgId: string): Promise<boolean> => {
    console.log('Deleting organization:', orgId);
    const org = orgData.organizations.find(o => o.id === orgId);
    if (!org) {
      console.log('Organization not found:', orgId);
      return false;
    }

    try {
      const { error } = await supabase
        .from('organizations')
        .delete()
        .eq('id', orgId);
      if (error) {
        console.warn('Failed to delete org from Supabase:', error.message);
      } else {
        console.log('Organization deleted from Supabase');
      }
    } catch (err) {
      console.warn('Supabase delete failed:', err);
    }

    const newData: OrgData = {
      ...orgData,
      organizations: orgData.organizations.filter(o => o.id !== orgId),
      teams: orgData.teams.filter(t => t.orgId !== orgId),
      events: orgData.events.filter(e => e.orgId !== orgId),
      eventTeams: orgData.eventTeams.filter(et => {
        const team = orgData.teams.find(t => t.id === et.teamId);
        return team?.orgId !== orgId;
      }),
      members: orgData.members.filter(m => m.orgId !== orgId),
      verifications: orgData.verifications.filter(v => {
        const event = orgData.events.find(e => e.id === v.eventId);
        return event?.orgId !== orgId;
      }),
      checkIns: orgData.checkIns.filter(c => {
        const event = orgData.events.find(e => e.id === c.eventId);
        return event?.orgId !== orgId;
      }),
      privacySettings: orgData.privacySettings.filter(p => p.orgId !== orgId),
      verificationPasses: orgData.verificationPasses.filter(p => p.issuingOrgId !== orgId),
      verificationViews: orgData.verificationViews,
    };

    await saveData(newData);

    if (currentOrgId === orgId) {
      const remaining = newData.organizations;
      if (remaining.length > 0) {
        await selectOrg(remaining[0].id);
      } else {
        await selectOrg(null);
      }
    }

    console.log('Organization deleted successfully:', orgId);
    return true;
  }, [orgData, saveData, currentOrgId, selectOrg]);

  const createEvent = useCallback(async (event: Omit<Event, 'id' | 'createdAt'>): Promise<Event> => {
    console.log('Creating event:', event.name);
    const newEvent: Event = {
      ...event,
      id: generateId(),
      createdAt: new Date().toISOString(),
    };

    const newData: OrgData = {
      ...orgData,
      events: [...orgData.events, newEvent],
    };

    await saveData(newData);
    return newEvent;
  }, [orgData, saveData]);

  const updateEvent = useCallback(async (event: Event) => {
    console.log('Updating event:', event.id);
    const newData: OrgData = {
      ...orgData,
      events: orgData.events.map(e => e.id === event.id ? event : e),
    };
    await saveData(newData);
  }, [orgData, saveData]);

  const deleteEvent = useCallback(async (eventId: string) => {
    console.log('Deleting event:', eventId);
    const newData: OrgData = {
      ...orgData,
      events: orgData.events.filter(e => e.id !== eventId),
      eventTeams: orgData.eventTeams.filter(et => et.eventId !== eventId),
      verifications: orgData.verifications.filter(v => v.eventId !== eventId),
      checkIns: orgData.checkIns.filter(c => c.eventId !== eventId),
    };
    if (currentEventId === eventId) {
      await selectEvent(null);
    }
    await saveData(newData);
  }, [orgData, saveData, currentEventId, selectEvent]);

  const addTeamToEvent = useCallback(async (eventId: string, teamId: string, isHomeTeam: boolean = false): Promise<EventTeam> => {
    console.log('Adding team to event:', { eventId, teamId });
    const team = orgData.teams.find(t => t.id === teamId);
    const org = team ? orgData.organizations.find(o => o.id === team.orgId) : null;

    const eventTeam: EventTeam = {
      id: generateId(),
      eventId,
      teamId,
      teamName: team?.name || 'Unknown Team',
      orgName: org?.name || 'Unknown Org',
      isHomeTeam,
      checkedInCount: 0,
      totalPlayers: 0,
    };

    const newData: OrgData = {
      ...orgData,
      eventTeams: [...orgData.eventTeams, eventTeam],
    };

    await saveData(newData);
    return eventTeam;
  }, [orgData, saveData]);

  const removeTeamFromEvent = useCallback(async (eventTeamId: string) => {
    console.log('Removing team from event:', eventTeamId);
    const newData: OrgData = {
      ...orgData,
      eventTeams: orgData.eventTeams.filter(et => et.id !== eventTeamId),
    };
    await saveData(newData);
  }, [orgData, saveData]);

  const createVerification = useCallback(async (
    verification: Omit<OpponentVerification, 'id' | 'createdAt'>
  ): Promise<OpponentVerification> => {
    console.log('Creating verification for player:', verification.playerName);
    const newVerification: OpponentVerification = {
      ...verification,
      id: generateId(),
      createdAt: new Date().toISOString(),
    };

    const newData: OrgData = {
      ...orgData,
      verifications: [...orgData.verifications, newVerification],
    };

    await saveData(newData);
    return newVerification;
  }, [orgData, saveData]);

  const updateVerification = useCallback(async (verification: OpponentVerification) => {
    console.log('Updating verification:', verification.id);
    const newData: OrgData = {
      ...orgData,
      verifications: orgData.verifications.map(v => v.id === verification.id ? verification : v),
    };
    await saveData(newData);
  }, [orgData, saveData]);

  const getMemberRole = useCallback((orgId: string, userId: string): UserOrgRole | null => {
    const member = orgData.members.find(m => m.orgId === orgId && m.userId === userId);
    return member?.role || null;
  }, [orgData.members]);

  const updateMemberRole = useCallback(async (memberId: string, role: UserOrgRole) => {
    console.log('Updating member role:', memberId, role);
    const newData: OrgData = {
      ...orgData,
      members: orgData.members.map(m => m.id === memberId ? { ...m, role } : m),
    };
    await saveData(newData);
  }, [orgData, saveData]);

  const removeMember = useCallback(async (memberId: string) => {
    console.log('Removing member:', memberId);
    const newData: OrgData = {
      ...orgData,
      members: orgData.members.filter(m => m.id !== memberId),
    };
    await saveData(newData);
  }, [orgData, saveData]);

  const getOrgMembers = useCallback((orgId: string): OrgMember[] => {
    return orgData.members.filter(m => m.orgId === orgId);
  }, [orgData.members]);

  const getOrgPrivacySettings = useCallback((orgId: string): OrgPrivacySettings | null => {
    return orgData.privacySettings.find(p => p.orgId === orgId) || null;
  }, [orgData.privacySettings]);

  const updateOrgPrivacySettings = useCallback(async (settings: Partial<OrgPrivacySettings> & { orgId: string }) => {
    console.log('Updating privacy settings for org:', settings.orgId);
    const existing = orgData.privacySettings.find(p => p.orgId === settings.orgId);
    
    const updatedSettings: OrgPrivacySettings = existing
      ? { ...existing, ...settings, updatedAt: new Date().toISOString() }
      : {
          id: generateId(),
          ...DEFAULT_PRIVACY_SETTINGS,
          ...settings,
          updatedAt: new Date().toISOString(),
        };

    const newData: OrgData = {
      ...orgData,
      privacySettings: existing
        ? orgData.privacySettings.map(p => p.orgId === settings.orgId ? updatedSettings : p)
        : [...orgData.privacySettings, updatedSettings],
    };
    await saveData(newData);
    return updatedSettings;
  }, [orgData, saveData]);

  const createVerificationPass = useCallback(async (
    eventId: string,
    teamId: string,
    createdBy: string,
    durationMinutes?: number
  ): Promise<VerificationPass> => {
    console.log('Creating verification pass for event:', eventId, 'team:', teamId);
    
    const team = orgData.teams.find(t => t.id === teamId);
    const orgId = team?.orgId || currentOrgId || '';
    const privacySettings = orgData.privacySettings.find(p => p.orgId === orgId);
    const duration = durationMinutes || privacySettings?.verificationPassDurationMinutes || 240;
    
    const code = generateVerificationCode();
    const token = `${eventId}-${teamId}-${code}-${Date.now()}`;
    
    const pass: VerificationPass = {
      id: generateId(),
      eventId,
      issuingTeamId: teamId,
      issuingOrgId: orgId,
      code,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + duration * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
      createdBy,
      isRevoked: false,
      revokedAt: null,
      revokedBy: null,
    };

    const newData: OrgData = {
      ...orgData,
      verificationPasses: [...orgData.verificationPasses, pass],
    };
    await saveData(newData);
    return pass;
  }, [orgData, saveData, currentOrgId]);

  const revokeVerificationPass = useCallback(async (passId: string, revokedBy: string) => {
    console.log('Revoking verification pass:', passId);
    const newData: OrgData = {
      ...orgData,
      verificationPasses: orgData.verificationPasses.map(p =>
        p.id === passId
          ? { ...p, isRevoked: true, revokedAt: new Date().toISOString(), revokedBy }
          : p
      ),
    };
    await saveData(newData);
  }, [orgData, saveData]);

  const redeemVerificationPass = useCallback(async (
    code: string,
    viewerUserId: string | null,
    players: Player[]
  ): Promise<{ pass: VerificationPass; roster: LimitedPlayerData[]; eventName: string; teamName: string } | null> => {
    console.log('Redeeming verification pass with code:', code);
    
    const pass = orgData.verificationPasses.find(
      p => p.code.toUpperCase() === code.toUpperCase() && !p.isRevoked
    );
    
    if (!pass) {
      console.log('Pass not found or revoked');
      return null;
    }
    
    if (new Date(pass.expiresAt) < new Date()) {
      console.log('Pass has expired');
      return null;
    }
    
    const privacySettings = orgData.privacySettings.find(p => p.orgId === pass.issuingOrgId)
      || { ...DEFAULT_PRIVACY_SETTINGS, id: '', orgId: pass.issuingOrgId, updatedAt: '' };
    
    const team = orgData.teams.find(t => t.id === pass.issuingTeamId);
    const event = orgData.events.find(e => e.id === pass.eventId);
    
    const teamPlayers = players.filter(p => {
      const matchesTeam = team && (
        p.ageGroup === team.ageGroup || 
        p.calculatedAgeGroup === team.ageGroup
      );
      return matchesTeam;
    });
    
    const limitedRoster: LimitedPlayerData[] = teamPlayers.map(player => {
      let displayName = '';
      if (privacySettings.showFullName) {
        displayName = `${player.firstName} ${player.lastName}`;
      } else {
        displayName = `${player.firstName} ${player.lastName.charAt(0)}.`;
      }
      
      return {
        id: player.id,
        displayName,
        jerseyNumber: privacySettings.showJerseyNumber ? (player as any).jerseyNumber || null : null,
        birthYear: privacySettings.showBirthYear && player.dateOfBirth 
          ? player.dateOfBirth.split('/').pop() || player.dateOfBirth.split('-')[0] || null 
          : null,
        photoUri: privacySettings.showPhoto ? player.photoUri : null,
        weight: privacySettings.showWeight ? player.weight : null,
        ageGroup: player.calculatedAgeGroup || player.ageGroup,
        division: player.division,
      };
    });
    
    const view: VerificationView = {
      id: generateId(),
      passId: pass.id,
      eventId: pass.eventId,
      viewedTeamId: pass.issuingTeamId,
      viewerUserId,
      viewerIp: null,
      viewedAt: new Date().toISOString(),
      playerCount: limitedRoster.length,
    };
    
    const newData: OrgData = {
      ...orgData,
      verificationViews: [...orgData.verificationViews, view],
    };
    await saveData(newData);
    
    return {
      pass,
      roster: limitedRoster,
      eventName: event?.name || 'Unknown Event',
      teamName: team?.name || 'Unknown Team',
    };
  }, [orgData, saveData]);

  const getVerificationViews = useCallback((passId: string): VerificationView[] => {
    return orgData.verificationViews.filter(v => v.passId === passId);
  }, [orgData.verificationViews]);

  const getEventPasses = useCallback((eventId: string): VerificationPass[] => {
    return orgData.verificationPasses.filter(p => p.eventId === eventId);
  }, [orgData.verificationPasses]);

  const checkInPlayer = useCallback(async (
    eventId: string,
    teamId: string,
    playerId: string,
    checkedInBy: string,
    photoUri: string | null,
    weightVerified: boolean,
    ageVerified: boolean
  ): Promise<EventCheckIn> => {
    console.log('Checking in player:', playerId, 'to event:', eventId);
    
    const checkIn: EventCheckIn = {
      id: generateId(),
      eventId,
      teamId,
      playerId,
      checkedInBy,
      checkedInAt: new Date().toISOString(),
      photoUri,
      weightVerified,
      ageVerified,
      syncStatus: isOnline ? 'synced' : 'pending',
    };

    if (!isOnline) {
      const offlineCheckIn: OfflineCheckIn = {
        ...checkIn,
        createdOfflineAt: new Date().toISOString(),
      };
      const newQueue = [...offlineQueue, offlineCheckIn];
      setOfflineQueue(newQueue);
      await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(newQueue));
      console.log('Stored check-in offline, queue size:', newQueue.length);
    }

    const newData: OrgData = {
      ...orgData,
      checkIns: [...orgData.checkIns, checkIn],
    };
    await saveData(newData);
    return checkIn;
  }, [orgData, saveData, isOnline, offlineQueue]);

  const getEventCheckIns = useCallback((eventId: string): EventCheckIn[] => {
    return orgData.checkIns.filter(c => c.eventId === eventId);
  }, [orgData.checkIns]);

  const syncOfflineCheckIns = useCallback(async () => {
    if (!isOnline || offlineQueue.length === 0) return;
    
    console.log('Syncing offline check-ins, count:', offlineQueue.length);
    
    const synced: string[] = [];
    for (const checkIn of offlineQueue) {
      try {
        console.log('Syncing check-in:', checkIn.id);
        synced.push(checkIn.id);
      } catch (error) {
        console.error('Failed to sync check-in:', checkIn.id, error);
      }
    }
    
    const remaining = offlineQueue.filter(c => !synced.includes(c.id));
    setOfflineQueue(remaining);
    await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(remaining));
    
    const newData: OrgData = {
      ...orgData,
      checkIns: orgData.checkIns.map(c =>
        synced.includes(c.id) ? { ...c, syncStatus: 'synced' as const } : c
      ),
    };
    await saveData(newData);
    
    console.log('Sync complete, synced:', synced.length, 'remaining:', remaining.length);
  }, [isOnline, offlineQueue, orgData, saveData]);

  useEffect(() => {
    if (isOnline && offlineQueue.length > 0) {
      void syncOfflineCheckIns();
    }
  }, [isOnline, offlineQueue.length, syncOfflineCheckIns]);

  return useMemo(() => ({
    organizations: orgData.organizations,
    teams: orgData.teams,
    events: orgData.events,
    eventTeams: orgData.eventTeams,
    verifications: orgData.verifications,
    members: orgData.members,
    checkIns: orgData.checkIns,
    currentOrg,
    currentEvent,
    currentOrgTeams,
    currentOrgEvents,
    currentEventTeams,
    currentEventVerifications,
    isLoading: orgDataQuery.isLoading || !isInitialized,
    isSaving,
    isOnline,
    offlineQueueCount: offlineQueue.length,
    selectOrg,
    selectEvent,
    createOrg,
    updateOrg,
    joinOrgByCode,
    createTeam,
    createTeamsBulk,
    clearOrgTeams,
    getOrgByName,
    shouldOverwriteOrgData,
    importTeamsWithOrgCheck,
    updateTeam,
    deleteTeam,
    deleteOrg,
    createEvent,
    updateEvent,
    deleteEvent,
    addTeamToEvent,
    removeTeamFromEvent,
    createVerification,
    updateVerification,
    getMemberRole,
    updateMemberRole,
    removeMember,
    getOrgMembers,
    getOrgPrivacySettings,
    updateOrgPrivacySettings,
    createVerificationPass,
    revokeVerificationPass,
    redeemVerificationPass,
    getVerificationViews,
    getEventPasses,
    checkInPlayer,
    getEventCheckIns,
    syncOfflineCheckIns,
  }), [
    orgData, currentOrg, currentEvent, currentOrgTeams, currentOrgEvents,
    currentEventTeams, currentEventVerifications, orgDataQuery.isLoading,
    isInitialized, isSaving, isOnline, offlineQueue.length,
    selectOrg, selectEvent, createOrg, updateOrg, joinOrgByCode,
    createTeam, createTeamsBulk, clearOrgTeams, getOrgByName,
    shouldOverwriteOrgData, importTeamsWithOrgCheck, updateTeam, deleteTeam,
    deleteOrg, createEvent, updateEvent, deleteEvent, addTeamToEvent,
    removeTeamFromEvent, createVerification, updateVerification,
    getMemberRole, updateMemberRole, removeMember, getOrgMembers,
    getOrgPrivacySettings, updateOrgPrivacySettings, createVerificationPass,
    revokeVerificationPass, redeemVerificationPass, getVerificationViews,
    getEventPasses, checkInPlayer, getEventCheckIns, syncOfflineCheckIns,
  ]);
});
