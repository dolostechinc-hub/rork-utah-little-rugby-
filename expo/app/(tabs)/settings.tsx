import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  TextInput,
  ActivityIndicator,
  Modal,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  useWindowDimensions,
} from 'react-native';
import {
  FileSpreadsheet,
  RefreshCw,
  Info,
  ExternalLink,
  Database,
  Shield,
  CheckCircle,
  CheckCircle2,
  XCircle,
  Unlink,
  X,
  Lock,
  Unlock,
  Key,
  Eye,
  EyeOff,
  ChevronLeft,
  ChevronRight,
  ArrowRight,
  UserPlus,
  Users,
  UserCog,
  ShieldCheck,
  ShieldOff,
  UserX,
  Building2,
  Copy,
  Share2,
  LogIn,
  Trash2,
  FileText,
  History,
  Edit3,
  LockKeyhole,
  UnlockKeyhole,
  Scale,
  AlertTriangle,
  Coins,
  ArrowUp,
  Link,
  Clock,
  Download,
} from 'lucide-react-native';
import { ParsedPlayer } from '@/components/CSVImportModal';
import { useRouter } from 'expo-router';
import { Linking } from 'react-native';
import { WEIGHT_LIMITS as _WEIGHT_LIMITS } from '@/utils/playerUtils';

import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRegistration } from '@/contexts/RegistrationContext';
import { useAuth } from '@/contexts/AuthContext';
import {
  listActiveEditorSessions,
  revokeEditorSession,
  type ActiveEditorSession,
} from '@/lib/editorSession';
import { useOrganization } from '@/contexts/OrganizationContext';
import * as Clipboard from 'expo-clipboard';
import Colors from '@/constants/colors';
import { fetchSheetCsv, parseCSV as parseCsvShared, extractSpreadsheetId as extractIdShared } from '@/lib/googleSheetsCsv';
import { useAgeGroupRules, AGE_GROUPS_FOR_RULES } from '@/contexts/AgeGroupRulesContext';
import { BookOpen, Pencil } from 'lucide-react-native';

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { 
    resetData, 
    stats, 
    isConnected, 
    sheetsConfig,
    disconnectFromSheets,
    refreshData,
    isFetching,
    hasError,
    lastSyncTime,
    connectionError,
    importPlayers,
    importMetadata,
    clearAllImportedData,
    isClearingData,
    savedSheetInfo,
    saveSheetInfo,
    enableWriteBack,
    disableWriteBack: _disableWriteBack,
    importedSheets,
    addImportedSheet,
    toggleSheetLock,
    toggleSheetEditing,
    deleteImportedSheet,
    pendingWriteCount,
    syncErrors,
    processPendingWrites,
    eventMode,
    setEventMode,
    showTeamAssignment,
    setShowTeamAssignment,
    players,
  } = useRegistration();

  const [isExporting, setIsExporting] = useState<boolean>(false);

  const [showConnectModal, setShowConnectModal] = useState(false);
  const [sheetUrl, setSheetUrl] = useState('');
  const [spreadsheetId, setSpreadsheetId] = useState<string | null>(null);
  const [modalConnectionError, setModalConnectionError] = useState<string | null>(null);
  const [sheetsStep, setSheetsStep] = useState<'url' | 'mapping' | 'preview' | 'importing' | 'complete'>('url');
  const [sheetsHeaders, setSheetsHeaders] = useState<string[]>([]);
  const [sheetsCsvData, setSheetsCsvData] = useState<string[][]>([]);
  const [sheetsColumnMapping, setSheetsColumnMapping] = useState<Record<string, number>>({});
  const [sheetsParsedPlayers, setSheetsParsedPlayers] = useState<ParsedPlayer[]>([]);
  const [isLoadingSheet, setIsLoadingSheet] = useState(false);

  const REQUIRED_FIELDS = ['firstName', 'lastName', 'club', 'ageGroup', 'division'];
  const ALL_FIELDS: { key: keyof ParsedPlayer; label: string; required: boolean }[] = [
    { key: 'firstName', label: 'First Name', required: true },
    { key: 'lastName', label: 'Last Name', required: true },
    { key: 'club', label: 'Club', required: true },
    { key: 'ageGroup', label: 'Age Group', required: true },
    { key: 'division', label: 'Division', required: true },
    { key: 'dateOfBirth', label: 'Date of Birth', required: false },
    { key: 'weight', label: 'Weight', required: false },
  ];

  const { 
    isAdmin, 
    isEditor,
    canEdit,
    role,
    login, 
    logout, 
    changeAdminPin,
    issueEditorPin,
    revokeAllEditorAccess,
    editorSession,
    grantAdminToOwner,
  } = useAuth();
  const editorPinEnabled = true;

  const {
    currentOrg,
    organizations,
    createOrg,
    joinOrgByCode,
    pushOrgToCloud,
    selectOrg,
    deleteOrg,
    leaveOrg,
    members,
    isLoading: _isOrgLoading,
  } = useOrganization();

  const { width: windowWidth } = useWindowDimensions();
  const _isLandscape = windowWidth > 600;

  const [showLoginModal, setShowLoginModal] = useState(false);
  const [showChangePinModal, setShowChangePinModal] = useState(false);
  const [showEditorPinModal, setShowEditorPinModal] = useState(false);
  const [showRevokeModal, setShowRevokeModal] = useState(false);
  const [showJoinOrgModal, setShowJoinOrgModal] = useState(false);
  const [showCreateOrgModal, setShowCreateOrgModal] = useState(false);
  const [orgCodeInput, setOrgCodeInput] = useState('');
  const [newOrgName, setNewOrgName] = useState('');
  const [showPrivacyPolicy, setShowPrivacyPolicy] = useState(false);
  const [showTermsOfService, setShowTermsOfService] = useState(false);
  const [showImportedSheetsModal, setShowImportedSheetsModal] = useState(false);
  const [showMyOrgsModal, setShowMyOrgsModal] = useState(false);
  const [orgError, setOrgError] = useState<string | null>(null);
  const [syncAllStatus, setSyncAllStatus] = useState<'idle' | 'syncing' | 'done' | 'error'>('idle');
  const [syncAllMessage, setSyncAllMessage] = useState<string | null>(null);
  const [pinInput, setPinInput] = useState('');
  const [volunteerNameInput, setVolunteerNameInput] = useState('');
  const [activeEditors, setActiveEditors] = useState<ActiveEditorSession[]>([]);
  const [loadingActiveEditors, setLoadingActiveEditors] = useState<boolean>(false);
  const [activeEditorsError, setActiveEditorsError] = useState<string | null>(null);
  const [currentPinInput, setCurrentPinInput] = useState('');
  const [newPinInput, setNewPinInput] = useState('');
  const [editorPinInput, setEditorPinInput] = useState('');
  const [editorPinMode, setEditorPinMode] = useState<'auto' | 'custom'>('auto');
  const [customEditorPinInput, setCustomEditorPinInput] = useState('');
  const [adminVerifyPin, setAdminVerifyPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [showPin, setShowPin] = useState(false);

  const { links: ruleLinks, setLink: setRuleLink, removeLink: removeRuleLink, isSaving: isSavingRuleLink } = useAgeGroupRules();
  const [editingRulesGroup, setEditingRulesGroup] = useState<string | null>(null);
  const [ruleUrlInput, setRuleUrlInput] = useState('');
  const [ruleUrlError, setRuleUrlError] = useState<string | null>(null);

  const openRulesLink = useCallback(async (url: string, ageGroup: string) => {
    if (!url) return;
    try {
      const supported = await Linking.canOpenURL(url);
      if (!supported) {
        Alert.alert('Cannot Open Link', 'This link cannot be opened on your device.');
        return;
      }
      await Linking.openURL(url);
    } catch (err) {
      console.error('Failed to open rules link for', ageGroup, err);
      Alert.alert('Error', 'Could not open the rules link.');
    }
  }, []);

  const handleOpenEditRule = useCallback((ageGroup: string) => {
    setEditingRulesGroup(ageGroup);
    setRuleUrlInput(ruleLinks[ageGroup] ?? '');
    setRuleUrlError(null);
  }, [ruleLinks]);

  const handleSaveRuleLink = useCallback(async () => {
    if (!editingRulesGroup) return;
    const trimmed = ruleUrlInput.trim();
    if (!trimmed) {
      await removeRuleLink(editingRulesGroup);
      setEditingRulesGroup(null);
      setRuleUrlInput('');
      return;
    }
    const isValid = /^https?:\/\/.+/i.test(trimmed);
    if (!isValid) {
      setRuleUrlError('Please enter a valid URL starting with http:// or https://');
      return;
    }
    try {
      await setRuleLink(editingRulesGroup, trimmed);
      setEditingRulesGroup(null);
      setRuleUrlInput('');
      setRuleUrlError(null);
    } catch (err) {
      console.error('Failed to save rules link', err);
      setRuleUrlError('Failed to save. Please try again.');
    }
  }, [editingRulesGroup, ruleUrlInput, removeRuleLink, setRuleLink]);

  const resetSheetsModal = useCallback(() => {
    setSheetsStep('url');
    setSheetUrl('');
    setSheetsHeaders([]);
    setSheetsCsvData([]);
    setSheetsColumnMapping({});
    setSheetsParsedPlayers([]);
    setModalConnectionError(null);
    setIsLoadingSheet(false);
  }, []);

  const extractSpreadsheetId = (url: string): string | null => extractIdShared(url);

  const parseCSV = (content: string): string[][] => parseCsvShared(content);

  const handleFetchGoogleSheet = async () => {
    const extractedId = extractSpreadsheetId(sheetUrl.trim());
    if (!extractedId) {
      setModalConnectionError('Please enter a valid Google Sheets URL.');
      return;
    }
    
    setSpreadsheetId(extractedId);
    setIsLoadingSheet(true);
    setModalConnectionError(null);
    console.log('Fetching Google Sheet:', extractedId);
    
    try {
      const content = await fetchSheetCsv(extractedId);
      console.log('CSV content length:', content.length);
      const parsed = parseCSV(content);
      console.log('Parsed rows:', parsed.length);
      
      if (parsed.length < 2) {
        setModalConnectionError('The spreadsheet must have a header row and at least one data row.');
        setIsLoadingSheet(false);
        return;
      }
      
      const headerRow = parsed[0];
      const dataRows = parsed.slice(1);
      
      setSheetsHeaders(headerRow);
      setSheetsCsvData(dataRows);

      const autoMapping: Record<string, number> = {};
      ALL_FIELDS.forEach(field => {
        const matchIndex = headerRow.findIndex((h: string) => {
          const normalized = h.toLowerCase().replace(/[_\s-]/g, '');
          const fieldNormalized = field.key.toLowerCase();
          const labelNormalized = field.label.toLowerCase().replace(/[_\s-]/g, '');
          return normalized === fieldNormalized || 
                 normalized === labelNormalized ||
                 normalized.includes(fieldNormalized) ||
                 fieldNormalized.includes(normalized);
        });
        if (matchIndex !== -1) {
          autoMapping[field.key] = matchIndex;
        }
      });

      console.log('Auto-mapped columns:', autoMapping);
      setSheetsColumnMapping(autoMapping);
      setSheetsStep('mapping');
    } catch (error) {
      console.error('Error fetching Google Sheet:', error);
      const message = error instanceof Error ? error.message : 'Failed to fetch Google Sheet';
      setModalConnectionError(message);
    } finally {
      setIsLoadingSheet(false);
    }
  };

  const handleSheetsMappingChange = (fieldKey: string, columnIndex: number) => {
    setSheetsColumnMapping(prev => ({
      ...prev,
      [fieldKey]: columnIndex,
    }));
  };

  const validateSheetsMapping = (): boolean => {
    const missingRequired = REQUIRED_FIELDS.filter(
      field => sheetsColumnMapping[field] === undefined
    );
    if (missingRequired.length > 0) {
      Alert.alert(
        'Missing Required Fields',
        `Please map the following required fields: ${missingRequired.join(', ')}`
      );
      return false;
    }
    return true;
  };

  const handleSheetsProceedToPreview = () => {
    if (!validateSheetsMapping()) return;

    const players: ParsedPlayer[] = sheetsCsvData.map(row => ({
      firstName: row[sheetsColumnMapping.firstName] || '',
      lastName: row[sheetsColumnMapping.lastName] || '',
      club: row[sheetsColumnMapping.club] || '',
      ageGroup: row[sheetsColumnMapping.ageGroup] || '',
      division: row[sheetsColumnMapping.division] || '',
      teamName: sheetsColumnMapping.teamName !== undefined ? row[sheetsColumnMapping.teamName] || '' : '',
      dateOfBirth: sheetsColumnMapping.dateOfBirth !== undefined ? row[sheetsColumnMapping.dateOfBirth] || '' : '',
      weight: sheetsColumnMapping.weight !== undefined ? row[sheetsColumnMapping.weight] || '' : '',
    })).filter(p => p.firstName && p.lastName);

    console.log('Parsed players:', players.length);
    setSheetsParsedPlayers(players);
    setSheetsStep('preview');
  };

  const handleSheetsImport = async () => {
    setSheetsStep('importing');
    try {
      console.log('=== STARTING GOOGLE SHEETS IMPORT ===' );
      console.log('Number of parsed players:', sheetsParsedPlayers.length);
      
      if (sheetsParsedPlayers.length === 0) {
        throw new Error('No players to import');
      }
      
      console.log('First player data:', JSON.stringify(sheetsParsedPlayers[0]));
      
      const playersToImport = sheetsParsedPlayers.map(p => ({
        firstName: p.firstName || '',
        lastName: p.lastName || '',
        club: p.club || '',
        ageGroup: p.ageGroup || '',
        division: p.division || '',
        teamName: p.teamName || '',
        dateOfBirth: p.dateOfBirth || '',
        weight: p.weight || '',
        isAgeVerified: false,
        photoUri: null,
        checkedIn: false,
        checkedInAt: null,
      }));
      
      console.log('Players prepared for import:', playersToImport.length);
      console.log('First prepared player:', JSON.stringify(playersToImport[0]));
      
      await importPlayers(playersToImport);
      
      console.log('=== IMPORT COMPLETE ===' );
      console.log('Successfully imported', playersToImport.length, 'players');

      if (spreadsheetId) {
        try {
          console.log('Attempting to import metadata from spreadsheet:', spreadsheetId);
          await importMetadata(spreadsheetId);
          console.log('Metadata import successful');
        } catch (metaError) {
          console.warn('Failed to import metadata (clubs/teams):', metaError);
        }
        
        // Save the sheet URL for future re-imports
        await saveSheetInfo(sheetUrl, spreadsheetId, 'Google Sheet');
        console.log('Sheet URL saved for future use');
        
        // Add to imported sheets history with access code
        const importedSheet = await addImportedSheet(
          spreadsheetId,
          sheetUrl,
          'Google Sheet',
          sheetsParsedPlayers.length,
          'admin'
        );
        console.log('Sheet added to history with access code:', importedSheet.accessCode);
      }
      
      if (spreadsheetId) {
        try {
          console.log('Auto-enabling write-back sync to Google Sheets...');
          await enableWriteBack(spreadsheetId, 'Players');
          console.log('Write-back sync enabled automatically after import');
        } catch (wbError) {
          console.warn('Failed to auto-enable write-back:', wbError);
        }
      }

      refreshData();
      
      setSheetsStep('complete');
      Alert.alert(
        'Import Complete',
        `Successfully imported ${sheetsParsedPlayers.length} players from Google Sheets.\n\nBidirectional sync is now active — any changes (check-ins, photos, weights) will automatically sync back to your Google Sheet.`
      );
    } catch (error) {
      console.error('=== IMPORT ERROR ===');
      console.error('Error details:', error);
      Alert.alert('Import Failed', error instanceof Error ? error.message : 'Some players could not be imported. Please try again.');
      setSheetsStep('preview');
    }
  };

  const handleCloseSheetsModal = () => {
    setShowConnectModal(false);
    resetSheetsModal();
  };

  const handleResetData = () => {
    Alert.alert(
      'Reset All Data',
      'This will reset all player data to the original mock data. All check-ins and added players will be lost. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: () => {
            resetData();
            Alert.alert('Data Reset', 'All player data has been reset.');
          },
        },
      ]
    );
  };

  const handleClearAllData = () => {
    Alert.alert(
      'Clear All Imported Data',
      'This will remove ALL imported players, spreadsheet connection, and metadata. You can then import a different spreadsheet. This action cannot be undone. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear All',
          style: 'destructive',
          onPress: async () => {
            try {
              await clearAllImportedData();
              Alert.alert('Data Cleared', 'All imported data has been removed. You can now import a new spreadsheet.');
            } catch (error) {
              console.error('Error clearing data:', error);
              Alert.alert('Error', 'Failed to clear data. Please try again.');
            }
          },
        },
      ]
    );
  };

  const handleExportCsv = useCallback(async () => {
    if (isExporting) return;
    if (!players || players.length === 0) {
      Alert.alert('No Data', 'There are no players to export yet.');
      return;
    }
    setIsExporting(true);
    try {
      console.log('[export-csv] starting export of', players.length, 'players');
      const escape = (val: unknown): string => {
        const s = val === null || val === undefined ? '' : String(val);
        if (/[",\n\r]/.test(s)) {
          return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
      };
      const headers = [
        'First Name',
        'Last Name',
        'Date of Birth',
        'Club',
        'Age Group',
        'Calculated Age Group',
        'Division',
        'Team Name',
        'Weight',
        'Restriction',
        'Parent Name',
        'Parent Phone',
        'Age Verified',
        'Checked In',
        'Checked In At',
        'Photo URL',
        'Player ID',
      ];
      const rows = players.map((p) => [
        p.firstName,
        p.lastName,
        p.dateOfBirth,
        p.club,
        p.ageGroup,
        p.calculatedAgeGroup ?? '',
        p.division,
        p.teamName,
        p.weight,
        p.restrictionStatus ?? 'none',
        p.parentName ?? '',
        p.parentPhone ?? '',
        p.isAgeVerified ? 'Yes' : 'No',
        p.checkedIn ? 'Yes' : 'No',
        p.checkedInAt ?? '',
        p.photoUri ?? '',
        p.id,
      ]);
      const csv = [headers, ...rows]
        .map((r) => r.map(escape).join(','))
        .join('\n');

      const ts = new Date();
      const pad = (n: number) => n.toString().padStart(2, '0');
      const fileName = `players_export_${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}.csv`;

      if (Platform.OS === 'web') {
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        Alert.alert('Export Complete', `Downloaded ${players.length} players to ${fileName}.`);
      } else {
        const FileSystem = await import('expo-file-system/legacy');
        const Sharing = await import('expo-sharing');
        const fileUri = `${FileSystem.documentDirectory}${fileName}`;
        await FileSystem.writeAsStringAsync(fileUri, csv, {
          encoding: FileSystem.EncodingType.UTF8,
        });
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) {
          await Sharing.shareAsync(fileUri, {
            mimeType: 'text/csv',
            dialogTitle: 'Export Players to CSV',
            UTI: 'public.comma-separated-values-text',
          });
        } else {
          Alert.alert('Saved', `File saved to ${fileUri}`);
        }
      }
      console.log('[export-csv] export complete');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('[export-csv] failed:', message);
      Alert.alert('Export Failed', message);
    } finally {
      setIsExporting(false);
    }
  }, [players, isExporting]);

  const handleDisconnect = () => {
    Alert.alert(
      'Disconnect from Google Sheets',
      'This will switch back to local storage mode. Your data will still be saved in the spreadsheet.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: async () => {
            await disconnectFromSheets();
            Alert.alert('Disconnected', 'Now using local storage mode.');
          },
        },
      ]
    );
  };

  const handleRefreshData = async () => {
    console.log('[settings] manual refresh from sheet');
    const result = await refreshData();
    if (!result.ok) {
      Alert.alert(
        'Refresh Failed',
        result.error ??
          'Could not pull the latest data. Please check your internet connection and that the sheet is shared with "Anyone with the link".',
      );
      return;
    }
    const newCount = result.imported ?? 0;
    const keptCount = result.duplicatesKept ?? 0;
    const lines: string[] = [];
    if (newCount > 0) {
      lines.push(`${newCount} new player${newCount === 1 ? '' : 's'} added.`);
    } else {
      lines.push('No new players found.');
    }
    if (keptCount > 0) {
      lines.push(
        `${keptCount} existing player${keptCount === 1 ? '' : 's'} kept with their photos, weights and check-in status.`,
      );
    }
    Alert.alert('Roster Refreshed', lines.join('\n\n'));
  };

  const formatRelativeShort = (d: Date): string => {
    const diffMs = Date.now() - d.getTime();
    const sec = Math.round(diffMs / 1000);
    if (sec < 60) return 'just now';
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.round(hr / 24);
    return `${day}d ago`;
  };

  const loadActiveEditors = useCallback(async () => {
    if (!isAdmin || !currentOrg) {
      setActiveEditors([]);
      return;
    }
    setLoadingActiveEditors(true);
    setActiveEditorsError(null);
    try {
      const rows = await listActiveEditorSessions(currentOrg.id, currentOrg.ownerId);
      setActiveEditors(rows);
    } catch (err) {
      console.warn('listActiveEditorSessions failed', err);
      setActiveEditorsError((err as Error).message || 'Could not load active editors.');
      setActiveEditors([]);
    } finally {
      setLoadingActiveEditors(false);
    }
  }, [isAdmin, currentOrg]);

  useEffect(() => {
    void loadActiveEditors();
    if (!isAdmin || !currentOrg) return;
    const interval = setInterval(() => {
      void loadActiveEditors();
    }, 30000);
    return () => clearInterval(interval);
  }, [loadActiveEditors, isAdmin, currentOrg]);

  const handleRevokeOneEditor = useCallback(
    (session: ActiveEditorSession) => {
      if (!currentOrg) return;
      const who = session.device_label?.trim() || 'this editor';
      Alert.alert(
        'Revoke Editor Access',
        `Drop ${who} back to view-only? They can rejoin later by entering the current Editor PIN again.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Revoke',
            style: 'destructive',
            onPress: async () => {
              try {
                await revokeEditorSession(session.id, currentOrg.ownerId);
                await loadActiveEditors();
              } catch (err) {
                console.error('revokeEditorSession failed', err);
                Alert.alert('Error', (err as Error).message || 'Could not revoke editor.');
              }
            },
          },
        ],
      );
    },
    [currentOrg, loadActiveEditors],
  );

  const handleLogin = async () => {
    setPinError(null);
    const trimmedName = volunteerNameInput.trim();
    if (currentOrg && trimmedName.length < 2) {
      setPinError('Please enter your name so the admin knows who you are.');
      return;
    }
    const result = await login(pinInput, currentOrg?.id, trimmedName || undefined);
    if (result.success) {
      setShowLoginModal(false);
      setPinInput('');
      setVolunteerNameInput('');
      const roleLabel = result.role === 'admin' ? 'Admin' : 'Editor';
      Alert.alert('Success', `You now have ${roleLabel} access.`);
    } else {
      setPinError(result.error ?? 'Invalid PIN. Please try again.');
    }
  };

  const handleLogout = () => {
    const modeLabel = isAdmin ? 'admin' : 'editor';
    Alert.alert(
      'Switch to View-Only Mode',
      `You will lose ${modeLabel} access until you enter the PIN again.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Switch',
          onPress: async () => {
            await logout();
            Alert.alert('View-Only Mode', 'You are now in view-only mode.');
          },
        },
      ]
    );
  };

  const handleChangeAdminPin = async () => {
    setPinError(null);
    if (newPinInput.length < 4) {
      setPinError('New PIN must be at least 4 digits.');
      return;
    }
    const success = await changeAdminPin(currentPinInput, newPinInput);
    if (success) {
      setShowChangePinModal(false);
      setCurrentPinInput('');
      setNewPinInput('');
      Alert.alert(
        'Admin PIN Changed',
        'Your admin PIN has been changed. All other admin sessions have been logged out.'
      );
    } else {
      setPinError('Current PIN is incorrect.');
    }
  };

  const handleSetEditorPin = async () => {
    setPinError(null);
    if (!currentOrg) {
      setPinError('Select an organization first.');
      return;
    }
    try {
      let customPin: string | undefined;
      if (editorPinMode === 'custom') {
        const cleaned = customEditorPinInput.trim();
        if (!/^[0-9]{4,10}$/.test(cleaned)) {
          setPinError('Custom PIN must be 4-10 digits.');
          return;
        }
        customPin = cleaned;
      }
      const { pin, expiresAt } = await issueEditorPin(currentOrg.id, {
        expiresInMinutes: 480,
        label: editorPinInput.trim() || undefined,
        adminUserId: currentOrg.ownerId,
        customPin,
      });
      setShowEditorPinModal(false);
      setAdminVerifyPin('');
      setEditorPinInput('');
      setCustomEditorPinInput('');
      setEditorPinMode('auto');
      const expiresLabel = new Date(expiresAt).toLocaleString([], {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
      });
      try {
        await Clipboard.setStringAsync(pin);
      } catch (clipErr) {
        console.warn('clipboard set failed', clipErr);
      }
      Alert.alert(
        'Editor PIN Generated',
        `PIN: ${pin}\n\nThis PIN has been copied to your clipboard.\n\nShare it with your helpers. On their device they tap "Unlock Access" in Settings and enter this PIN to become an editor.\n\nExpires: ${expiresLabel}.\n\nGenerating a new PIN automatically revokes the previous one.`,
        [
          { text: 'OK' },
          {
            text: 'Copy Again',
            onPress: () => {
              void Clipboard.setStringAsync(pin);
            },
          },
        ],
      );
    } catch (err) {
      console.error('issueEditorPin failed', err);
      setPinError((err as Error).message || 'Could not generate PIN.');
    }
  };

  const handleDisableEditorAccess = () => {
    Alert.alert(
      'Disable Editor Access',
      'This will revoke all editor access. People with the editor PIN will no longer be able to log in. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disable',
          style: 'destructive',
          onPress: async () => {
            setShowRevokeModal(true);
          },
        },
      ]
    );
  };

  const handleConfirmDisableEditor = async () => {
    setPinError(null);
    if (!currentOrg) {
      setPinError('Select an organization first.');
      return;
    }
    try {
      await revokeAllEditorAccess(currentOrg.id, currentOrg.ownerId);
      setShowRevokeModal(false);
      setAdminVerifyPin('');
      Alert.alert('Editor Access Revoked', 'All editor PINs and sessions have been revoked.');
    } catch (err) {
      setPinError((err as Error).message || 'Failed to revoke.');
    }
  };

  const handleCopyOrgCode = async () => {
    if (currentOrg?.code) {
      await Clipboard.setStringAsync(currentOrg.code);
      Alert.alert('Copied!', 'Organization code copied to clipboard. Share this with your volunteers.');
    }
  };

  const handleShareOrgCode = async () => {
    if (currentOrg) {
      const message = `Join ${currentOrg.name} on the Youth Sports Registration app!\n\nOrganization Code: ${currentOrg.code}\n\nEnter this code in the app to join our organization.`;
      Alert.alert('Share Code', message);
    }
  };

  const handleJoinOrg = async () => {
    setOrgError(null);
    if (!orgCodeInput.trim()) {
      setOrgError('Please enter an organization code.');
      return;
    }
    
    const userId = `user-${Date.now()}`;
    const result = await joinOrgByCode(orgCodeInput.trim().toUpperCase(), userId, 'Volunteer', '');
    
    if (result) {
      setShowJoinOrgModal(false);
      setOrgCodeInput('');
      Alert.alert('Success!', `You have joined ${result.name}. You now have view-only access. Contact the admin for edit permissions.`);
    } else {
      setOrgError('Invalid organization code. Please check and try again.');
    }
  };

  const handleCreateOrg = async () => {
    setOrgError(null);
    if (!newOrgName.trim()) {
      setOrgError('Please enter an organization name.');
      return;
    }
    
    const userId = `owner-${Date.now()}`;
    const org = await createOrg(newOrgName.trim(), userId);

    try {
      await grantAdminToOwner();
    } catch (err) {
      console.warn('[handleCreateOrg] grantAdminToOwner failed:', err);
    }

    setShowCreateOrgModal(false);
    setNewOrgName('');
    Alert.alert(
      'Organization Created!',
      `Your organization code is: ${org.code}\n\nYou are now the admin of this organization. Share the code with volunteers so they can join, then generate an Editor PIN below to give them check-in access.`,
      [{ text: 'Copy Code', onPress: () => Clipboard.setStringAsync(org.code) }, { text: 'OK' }]
    );
  };

  const handleDeleteOrg = (orgId: string, orgName: string) => {
    const orgMembers = members.filter(m => m.orgId === orgId);
    const isOwnerOrAdmin = orgMembers.some(
      m => (m.role === 'owner' || m.role === 'admin') && m.userId.startsWith('owner-')
    );
    if (!isOwnerOrAdmin && !isAdmin) {
      Alert.alert('Permission Denied', 'Only the organization admin can delete this organization.');
      return;
    }
    Alert.alert(
      'Delete Organization?',
      `Are you sure you want to delete "${orgName}"?\n\nThis will permanently remove:\n• All teams and events\n• All members and roles\n• Google Sheet connections\n\nYou will need to re-create the organization and re-add your Google Sheet if you change your mind.\n\nThis action cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Yes, Delete Organization',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              'Final Confirmation',
              `Type confirm: Are you absolutely sure you want to delete "${orgName}"? All data will be lost and you will need to set everything up again including the Google Sheet.`,
              [
                { text: 'No, Keep It', style: 'cancel' },
                {
                  text: 'Delete Permanently',
                  style: 'destructive',
                  onPress: async () => {
                    const success = await deleteOrg(orgId);
                    if (success) {
                      Alert.alert('Organization Deleted', `"${orgName}" has been permanently deleted. You will need to create a new organization and re-add your Google Sheet to continue.`);
                    } else {
                      Alert.alert('Error', 'Failed to delete organization. Please try again.');
                    }
                  },
                },
              ]
            );
          },
        },
      ]
    );
  };

  const _handleRevokeEditorSessions = () => {
    if (!currentOrg) return;
    Alert.alert(
      'Revoke All Editor Sessions',
      'This will log out all editors. They will need a new editor PIN to regain access. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke',
          style: 'destructive',
          onPress: async () => {
            try {
              await revokeAllEditorAccess(currentOrg.id, currentOrg.ownerId);
              Alert.alert('Sessions Revoked', 'All editor sessions have been logged out.');
            } catch (err) {
              Alert.alert('Error', (err as Error).message);
            }
          },
        },
      ]
    );
  };

  const getRoleLabel = () => {
    switch (role) {
      case 'admin': return 'Admin';
      case 'editor': return 'Editor';
      default: return 'Viewer';
    }
  };

  const getRoleDescription = () => {
    switch (role) {
      case 'admin':
        return 'You have full access to check in players, add new players, import data, manage settings, and control who has edit access.';
      case 'editor':
        return 'You can check in players, add new players, and import data. You cannot change access settings.';
      default:
        return 'You can view player information and roster. Enter a PIN to unlock edit access.';
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={[styles.content, { paddingTop: insets.top + 20 }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Settings</Text>
        <Text style={styles.subtitle}>Configure your registration app</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Organization</Text>
        
        {organizations.length > 0 && (
          <TouchableOpacity
            style={styles.myOrgsButton}
            onPress={() => setShowMyOrgsModal(true)}
            activeOpacity={0.7}
          >
            <Building2 size={18} color={Colors.primary} />
            <Text style={styles.myOrgsButtonText}>My Organizations ({organizations.length})</Text>
            <ChevronRight size={18} color={Colors.textMuted} />
          </TouchableOpacity>
        )}

        {currentOrg ? (
          <View style={styles.orgCard}>
            <View style={styles.orgHeader}>
              <Building2 size={24} color={Colors.primary} />
              <View style={styles.orgInfo}>
                <Text style={styles.orgName}>{currentOrg.name}</Text>
                <Text style={styles.orgRole}>
                  {isAdmin ? 'Admin' : isEditor ? 'Editor' : 'Volunteer'}
                </Text>
              </View>
            </View>
            
            {isAdmin && (
              <View style={styles.orgCodeSection}>
                <Text style={styles.orgCodeLabel}>Invite Code</Text>
                <View style={styles.orgCodeRow}>
                  <Text style={styles.orgCode}>{currentOrg.code}</Text>
                  <TouchableOpacity
                    style={styles.copyButton}
                    onPress={handleCopyOrgCode}
                    activeOpacity={0.7}
                  >
                    <Copy size={18} color={Colors.primary} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.shareButton}
                    onPress={handleShareOrgCode}
                    activeOpacity={0.7}
                  >
                    <Share2 size={18} color={Colors.primary} />
                  </TouchableOpacity>
                </View>
                <Text style={styles.orgCodeHint}>
                  Share this code with volunteers to let them join your organization
                </Text>
              </View>
            )}
            
            {organizations.length > 1 && (
              <TouchableOpacity
                style={styles.switchOrgButton}
                onPress={() => {
                  Alert.alert(
                    'Switch Organization',
                    'Select an organization',
                    organizations.map(org => ({
                      text: org.name,
                      onPress: () => selectOrg(org.id),
                    }))
                  );
                }}
                activeOpacity={0.7}
              >
                <Text style={styles.switchOrgText}>Switch Organization</Text>
              </TouchableOpacity>
            )}

            <View style={styles.orgActions}>
              <TouchableOpacity
                style={styles.joinOrgButton}
                onPress={() => {
                  setOrgCodeInput('');
                  setOrgError(null);
                  setShowJoinOrgModal(true);
                }}
                activeOpacity={0.7}
              >
                <LogIn size={18} color={Colors.white} />
                <Text style={styles.joinOrgButtonText}>Join Another</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.createOrgButton}
                onPress={() => {
                  setNewOrgName('');
                  setOrgError(null);
                  setShowCreateOrgModal(true);
                }}
                activeOpacity={0.7}
              >
                <Building2 size={18} color={Colors.primary} />
                <Text style={styles.createOrgButtonText}>Create New</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <View style={styles.noOrgCard}>
            <Building2 size={32} color={Colors.textMuted} />
            <Text style={styles.noOrgTitle}>No Organization</Text>
            <Text style={styles.noOrgText}>
              Join an existing organization or create a new one
            </Text>
            <View style={styles.orgActions}>
              <TouchableOpacity
                style={styles.joinOrgButton}
                onPress={() => {
                  setOrgCodeInput('');
                  setOrgError(null);
                  setShowJoinOrgModal(true);
                }}
                activeOpacity={0.7}
              >
                <LogIn size={18} color={Colors.white} />
                <Text style={styles.joinOrgButtonText}>Join Organization</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.createOrgButton}
                onPress={() => {
                  setNewOrgName('');
                  setOrgError(null);
                  setShowCreateOrgModal(true);
                }}
                activeOpacity={0.7}
              >
                <Building2 size={18} color={Colors.primary} />
                <Text style={styles.createOrgButtonText}>Create New</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Access Control</Text>

        {canEdit ? (
          <View style={[styles.adminCard, isEditor && styles.editorCard]}>
            <View style={styles.adminHeader}>
              {isAdmin ? (
                <ShieldCheck size={24} color={Colors.primary} />
              ) : (
                <UserCog size={24} color={Colors.info} />
              )}
              <Text style={[styles.adminTitle, isEditor && styles.editorTitle]}>
                {getRoleLabel()} Access Active
              </Text>
            </View>
            <Text style={styles.adminDetail}>{getRoleDescription()}</Text>
            
            <View style={styles.adminActions}>
              {isAdmin && (
                <TouchableOpacity
                  style={styles.changePinButton}
                  onPress={() => setShowChangePinModal(true)}
                  activeOpacity={0.7}
                >
                  <Key size={18} color={Colors.primary} />
                  <Text style={styles.changePinButtonText}>Change Admin PIN</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={styles.logoutButton}
                onPress={handleLogout}
                activeOpacity={0.7}
              >
                <Lock size={18} color={Colors.warning} />
                <Text style={styles.logoutButtonText}>View-Only Mode</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <View style={styles.viewerCard}>
            <View style={styles.viewerHeader}>
              <Lock size={24} color={Colors.textSecondary} />
              <Text style={styles.viewerTitle}>View-Only Mode</Text>
            </View>
            <Text style={styles.viewerDetail}>{getRoleDescription()}</Text>
            <TouchableOpacity
              style={styles.unlockButton}
              onPress={() => setShowLoginModal(true)}
              activeOpacity={0.7}
            >
              <Unlock size={18} color={Colors.white} />
              <Text style={styles.unlockButtonText}>Unlock Access</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {isAdmin && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Editor Access Management</Text>
          
          <View style={styles.editorManagementCard}>
            <View style={styles.editorStatusRow}>
              <Users size={20} color={Colors.success} />
              <View style={styles.editorStatusContent}>
                <Text style={styles.editorStatusTitle}>Editor PINs</Text>
                <Text style={styles.editorStatusSubtitle}>
                  Generate a one-time PIN and share it with a helper. They tap "Unlock Access" in Settings on their device and enter the PIN to become an editor. Each new PIN automatically revokes the previous one.
                </Text>
              </View>
            </View>

            <View style={styles.editorActions}>
              <TouchableOpacity
                style={styles.editorActionButton}
                onPress={() => {
                  setEditorPinInput('');
                  setCustomEditorPinInput('');
                  setEditorPinMode('auto');
                  setAdminVerifyPin('');
                  setPinError(null);
                  setShowEditorPinModal(true);
                }}
                activeOpacity={0.7}
                testID="generate-editor-pin-button"
              >
                <Key size={18} color={Colors.primary} />
                <Text style={styles.editorActionText}>Generate Editor PIN</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.editorActionButton, styles.editorActionDanger]}
                onPress={handleDisableEditorAccess}
                activeOpacity={0.7}
                testID="revoke-editor-access-button"
              >
                <ShieldOff size={18} color={Colors.error} />
                <Text style={[styles.editorActionText, styles.editorActionTextDanger]}>
                  Revoke All Editor Access
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.activeEditorsCard}>
            <View style={styles.activeEditorsHeader}>
              <View style={styles.activeEditorsTitleRow}>
                <UserCog size={18} color={Colors.text} />
                <Text style={styles.activeEditorsTitle}>Active Editors</Text>
                <View style={styles.activeEditorsCountPill}>
                  <Text style={styles.activeEditorsCountText}>{activeEditors.length}</Text>
                </View>
              </View>
              <TouchableOpacity
                onPress={() => void loadActiveEditors()}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                testID="refresh-active-editors"
              >
                <RefreshCw size={16} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>

            {loadingActiveEditors && activeEditors.length === 0 ? (
              <View style={styles.activeEditorsEmpty}>
                <ActivityIndicator size="small" color={Colors.primary} />
                <Text style={styles.activeEditorsEmptyText}>Loading…</Text>
              </View>
            ) : activeEditorsError ? (
              <View style={styles.activeEditorsEmpty}>
                <Text style={styles.activeEditorsErrorText}>{activeEditorsError}</Text>
              </View>
            ) : activeEditors.length === 0 ? (
              <View style={styles.activeEditorsEmpty}>
                <Text style={styles.activeEditorsEmptyText}>
                  No volunteers have unlocked editor access yet. Share your Editor PIN — once they enter it (with their name) they will appear here.
                </Text>
              </View>
            ) : (
              <View>
                {activeEditors.map((s) => {
                  const name = s.device_label?.trim() || 'Unnamed editor';
                  const last = s.last_used_at ? new Date(s.last_used_at) : null;
                  const issued = new Date(s.issued_at);
                  const lastLabel = last
                    ? `Active ${formatRelativeShort(last)}`
                    : `Joined ${formatRelativeShort(issued)}`;
                  return (
                    <View key={s.id} style={styles.activeEditorRow} testID={`active-editor-${s.id}`}>
                      <View style={styles.activeEditorAvatar}>
                        <Text style={styles.activeEditorAvatarText}>
                          {name.charAt(0).toUpperCase()}
                        </Text>
                      </View>
                      <View style={styles.activeEditorInfo}>
                        <Text style={styles.activeEditorName} numberOfLines={1}>
                          {name}
                        </Text>
                        <Text style={styles.activeEditorMeta} numberOfLines={1}>
                          {lastLabel}
                        </Text>
                      </View>
                      <TouchableOpacity
                        style={styles.activeEditorRevoke}
                        onPress={() => handleRevokeOneEditor(s)}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                        testID={`revoke-editor-${s.id}`}
                      >
                        <UserX size={16} color={Colors.error} />
                        <Text style={styles.activeEditorRevokeText}>Revoke</Text>
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </View>
            )}
          </View>

          <View style={styles.infoCard}>
            <View style={styles.infoRow}>
              <Info size={20} color={Colors.textSecondary} />
              <View style={styles.infoContent}>
                <Text style={styles.infoTitle}>How Editor Access Works</Text>
                <Text style={styles.infoText}>
                  • Tap "Generate Editor PIN" — the app creates a 6-digit PIN.{'\n'}
                  • Share that PIN with your helper. On their device they go to Settings → Unlock Access → enter the PIN.{'\n'}
                  • Editors can check in players and add new players, but cannot change PINs or settings.{'\n'}
                  • PINs expire after 8 hours by default.{'\n'}
                  • Generate a new PIN to rotate, or tap "Revoke All Editor Access" to instantly drop everyone back to viewer-only.
                </Text>
              </View>
            </View>
          </View>
        </View>
      )}

      {canEdit && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Player Management</Text>

          <TouchableOpacity
            style={styles.card}
            onPress={() => router.push('/add-player')}
            activeOpacity={0.7}
          >
            <View style={[styles.iconBg, { backgroundColor: Colors.primaryLight }]}>
              <UserPlus size={24} color={Colors.primary} />
            </View>
            <View style={styles.cardContent}>
              <Text style={styles.cardTitle}>Add Player</Text>
              <Text style={styles.cardDescription}>
                Manually add a new player to the roster
              </Text>
            </View>
            <ChevronRight size={20} color={Colors.textMuted} />
          </TouchableOpacity>
        </View>
      )}

      {canEdit && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Data Import</Text>

          {savedSheetInfo && !isConnected && (
            <View style={styles.savedSheetCard}>
              <View style={styles.savedSheetHeader}>
                <FileSpreadsheet size={20} color="#34A853" />
                <View style={styles.savedSheetInfo}>
                  <Text style={styles.savedSheetTitle}>Saved Google Sheet</Text>
                  <Text style={styles.savedSheetDetail}>
                    Last imported: {new Date(savedSheetInfo.lastImportedAt).toLocaleDateString()}
                  </Text>
                </View>
              </View>
              <Text style={styles.savedSheetId} numberOfLines={1}>
                ID: {savedSheetInfo.spreadsheetId.slice(0, 25)}...
              </Text>
              <View style={styles.savedSheetActions}>
                <TouchableOpacity
                  style={styles.reImportButton}
                  onPress={() => {
                    setSheetUrl(`https://docs.google.com/spreadsheets/d/${savedSheetInfo.spreadsheetId}`);
                    setShowConnectModal(true);
                  }}
                  activeOpacity={0.7}
                >
                  <RefreshCw size={16} color={Colors.white} />
                  <Text style={styles.reImportButtonText}>Re-import Data</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.enableWriteBackButton}
                  onPress={async () => {
                    try {
                      await enableWriteBack(savedSheetInfo.spreadsheetId, 'Players');
                      Alert.alert(
                        'Write-Back Enabled',
                        'Changes you make (check-ins, weights, photos) will now sync to your Google Sheet.\n\nNote: The sheet must be shared with the service account for this to work.'
                      );
                    } catch {
                      Alert.alert('Error', 'Failed to enable write-back. Please try again.');
                    }
                  }}
                  activeOpacity={0.7}
                >
                  <Database size={16} color="#34A853" />
                  <Text style={styles.enableWriteBackText}>Enable Sync</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {isConnected ? (
            <View style={[styles.connectedCard, hasError && styles.connectedCardError]}>
              <View style={styles.connectedHeader}>
                {hasError ? (
                  <XCircle size={24} color={Colors.warning} />
                ) : isFetching ? (
                  <ActivityIndicator size={24} color="#4CAF50" />
                ) : (
                  <CheckCircle size={24} color="#4CAF50" />
                )}
                <Text style={[styles.connectedTitle, hasError && styles.connectedTitleError]}>
                  {hasError ? 'Reconnecting…' : isFetching ? 'Syncing...' : 'Connected to Google Sheets'}
                </Text>
              </View>
              {hasError && connectionError && (
                <View style={styles.errorBanner}>
                  <Text style={styles.errorBannerText}>
                    Temporary issue reaching Google Sheets. We’ll keep retrying automatically and your data stays safe locally.
                  </Text>
                </View>
              )}
              <Text style={styles.connectedDetail}>
                Spreadsheet ID: {sheetsConfig?.spreadsheetId?.slice(0, 20)}...
              </Text>
              <Text style={styles.connectedDetail}>
                Sheet: {sheetsConfig?.sheetName || 'Players'}
              </Text>
              {lastSyncTime > 0 && (
                <Text style={styles.syncTime}>
                  Last synced: {new Date(lastSyncTime).toLocaleTimeString()}
                </Text>
              )}
              <View style={styles.connectedActions}>
                <TouchableOpacity
                  style={[styles.refreshButton, isFetching && styles.refreshButtonDisabled]}
                  onPress={handleRefreshData}
                  activeOpacity={0.7}
                  disabled={isFetching}
                >
                  {isFetching ? (
                    <ActivityIndicator size={18} color={Colors.primary} />
                  ) : (
                    <RefreshCw size={18} color={Colors.primary} />
                  )}
                  <Text style={styles.refreshButtonText}>{isFetching ? 'Syncing...' : 'Refresh Data'}</Text>
                </TouchableOpacity>
                {isAdmin && (
                  <TouchableOpacity
                    style={styles.disconnectButton}
                    onPress={handleDisconnect}
                    activeOpacity={0.7}
                  >
                    <Unlink size={18} color={Colors.error} />
                    <Text style={styles.disconnectButtonText}>Disconnect</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          ) : (
            <TouchableOpacity
              style={styles.card}
              onPress={() => setShowConnectModal(true)}
              activeOpacity={0.7}
            >
              <View style={[styles.iconBg, { backgroundColor: '#E8F5E9' }]}>
                <FileSpreadsheet size={24} color="#4CAF50" />
              </View>
              <View style={styles.cardContent}>
                <Text style={styles.cardTitle}>Import from Google Sheets</Text>
                <Text style={styles.cardDescription}>
                  Import players from a shared spreadsheet
                </Text>
              </View>
              <ExternalLink size={20} color={Colors.textMuted} />
            </TouchableOpacity>
          )}

          <View style={styles.statusCard}>
            <View style={styles.statusRow}>
              <Database size={18} color={Colors.textSecondary} />
              <Text style={styles.statusLabel}>Current Data</Text>
            </View>
            <Text style={styles.statusValue}>
              {stats.total} players loaded
            </Text>
            <Text style={styles.statusNote}>
              {stats.checkedIn} checked in this week
            </Text>
            {pendingWriteCount > 0 && (
              <View style={styles.pendingSyncRow}>
                <ActivityIndicator size={14} color="#F59E0B" />
                <Text style={styles.pendingSyncText}>
                  {pendingWriteCount} change{pendingWriteCount !== 1 ? 's' : ''} waiting to sync
                </Text>
                <TouchableOpacity
                  onPress={() => void processPendingWrites()}
                  activeOpacity={0.7}
                  style={styles.retrySyncButton}
                >
                  <Text style={styles.retrySyncText}>Retry</Text>
                </TouchableOpacity>
              </View>
            )}
            {syncErrors.length > 0 && (
              <View style={styles.syncErrorRow}>
                <XCircle size={14} color={Colors.error} />
                <Text style={styles.syncErrorText} numberOfLines={2}>
                  {syncErrors[syncErrors.length - 1]}
                </Text>
              </View>
            )}
          </View>
        </View>
      )}

      {isAdmin && importedSheets.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Imported Sheets History</Text>
          
          <TouchableOpacity
            style={styles.card}
            onPress={() => setShowImportedSheetsModal(true)}
            activeOpacity={0.7}
          >
            <View style={[styles.iconBg, { backgroundColor: '#E8F5E9' }]}>
              <History size={24} color="#34A853" />
            </View>
            <View style={styles.cardContent}>
              <Text style={styles.cardTitle}>Manage Imported Sheets</Text>
              <Text style={styles.cardDescription}>
                {importedSheets.length} sheet{importedSheets.length !== 1 ? 's' : ''} saved • View access codes & permissions
              </Text>
            </View>
            <ChevronRight size={20} color={Colors.textMuted} />
          </TouchableOpacity>

          <View style={styles.infoCard}>
            <View style={styles.infoRow}>
              <Info size={20} color={Colors.textSecondary} />
              <View style={styles.infoContent}>
                <Text style={styles.infoTitle}>Sheet Access Codes</Text>
                <Text style={styles.infoText}>
                  Each imported sheet has a unique access code. Share this code with users who need to re-import or access the same data. By default, users join with view-only permissions.
                </Text>
              </View>
            </View>
          </View>
        </View>
      )}

      {isAdmin && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Data Management</Text>

          {stats.total > 0 && (
            <TouchableOpacity
              style={styles.card}
              onPress={handleExportCsv}
              activeOpacity={0.7}
              disabled={isExporting}
              testID="export-csv-button"
            >
              <View style={[styles.iconBg, { backgroundColor: '#E8F5E9' }]}>
                {isExporting ? (
                  <ActivityIndicator size={24} color="#34A853" />
                ) : (
                  <Download size={24} color="#34A853" />
                )}
              </View>
              <View style={styles.cardContent}>
                <Text style={styles.cardTitle}>
                  {isExporting ? 'Exporting...' : 'Export to CSV'}
                </Text>
                <Text style={styles.cardDescription}>
                  Download all {stats.total} players (check-ins, weights, photos) as a CSV file you can paste into Google Sheets
                </Text>
              </View>
              <ChevronRight size={20} color={Colors.textMuted} />
            </TouchableOpacity>
          )}

          {stats.total > 0 && (
            <TouchableOpacity
              style={styles.card}
              onPress={handleClearAllData}
              activeOpacity={0.7}
              disabled={isClearingData}
            >
              <View style={[styles.iconBg, { backgroundColor: Colors.errorLight }]}>
                {isClearingData ? (
                  <ActivityIndicator size={24} color={Colors.error} />
                ) : (
                  <Trash2 size={24} color={Colors.error} />
                )}
              </View>
              <View style={styles.cardContent}>
                <Text style={[styles.cardTitle, { color: Colors.error }]}>
                  {isClearingData ? 'Clearing...' : 'Clear All Imported Data'}
                </Text>
                <Text style={styles.cardDescription}>
                  Remove all players and start fresh with a new spreadsheet
                </Text>
              </View>
            </TouchableOpacity>
          )}

          {!isConnected && (
            <TouchableOpacity
              style={styles.card}
              onPress={handleResetData}
              activeOpacity={0.7}
            >
              <View style={[styles.iconBg, { backgroundColor: Colors.warningLight }]}>
                <RefreshCw size={24} color={Colors.warning} />
              </View>
              <View style={styles.cardContent}>
                <Text style={styles.cardTitle}>Reset Demo Data</Text>
                <Text style={styles.cardDescription}>
                  Restore original sample players
                </Text>
              </View>
            </TouchableOpacity>
          )}
        </View>
      )}

      {isAdmin && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Event Mode</Text>
          <View style={styles.eventModeCard}>
            <View style={styles.eventModeHeader}>
              <View style={[styles.eventModeIcon, { backgroundColor: eventMode === 'registration' ? '#DCFCE7' : '#FEF3C7' }]}>
                {eventMode === 'registration' ? (
                  <UserPlus size={22} color="#16A34A" />
                ) : (
                  <Eye size={22} color="#D97706" />
                )}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.eventModeTitle}>
                  {eventMode === 'registration' ? 'Registration Mode' : 'View-Only Mode'}
                </Text>
                <Text style={styles.eventModeSubtitle}>
                  {eventMode === 'registration'
                    ? 'Editors can check in players and make changes. Changes sync in the background when saved.'
                    : 'Event is locked. Only the admin and users granted edit access can make changes. Everyone else is view-only.'}
                </Text>
              </View>
            </View>

            <View style={styles.eventModeToggleRow}>
              <TouchableOpacity
                style={[styles.eventModeButton, eventMode === 'registration' && styles.eventModeButtonActive]}
                onPress={() => {
                  if (eventMode !== 'registration') {
                    Alert.alert(
                      'Switch to Registration Mode?',
                      'This will allow check-ins and edits again across all devices using this sheet.',
                      [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Switch', onPress: () => void setEventMode('registration') },
                      ]
                    );
                  }
                }}
                activeOpacity={0.7}
              >
                <UserPlus size={16} color={eventMode === 'registration' ? Colors.white : Colors.textSecondary} />
                <Text style={[styles.eventModeButtonText, eventMode === 'registration' && styles.eventModeButtonTextActive]}>Registration</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.eventModeButton, eventMode === 'viewOnly' && styles.eventModeButtonActiveView]}
                onPress={() => {
                  if (eventMode !== 'viewOnly') {
                    Alert.alert(
                      'Lock Event to View-Only?',
                      'This will immediately revoke edit access from everyone (including current editors). A NEW editor PIN will be generated. You can share this new PIN only with people you trust to make changes.',
                      [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Lock & Rotate PIN',
                          style: 'destructive',
                          onPress: async () => {
                            try {
                              if (!currentOrg) throw new Error('Select an organization first');
                              await revokeAllEditorAccess(currentOrg.id, currentOrg.ownerId);
                              const { pin: newPin } = await issueEditorPin(currentOrg.id, { expiresInMinutes: 480, adminUserId: currentOrg.ownerId });
                              await setEventMode('viewOnly');
                              Alert.alert(
                                'Event Locked',
                                `The event is now view-only. All previous editors have been logged out.\n\nNew Editor PIN: ${newPin}\n\nShare this PIN only with people you want to grant edit access to. You can change it anytime in PIN Management.`,
                                [{ text: 'Got it' }]
                              );
                            } catch (err) {
                              console.error('Failed to lock event:', err);
                              Alert.alert('Error', 'Failed to lock the event. Please try again.');
                            }
                          },
                        },
                      ]
                    );
                  }
                }}
                activeOpacity={0.7}
              >
                <Eye size={16} color={eventMode === 'viewOnly' ? Colors.white : Colors.textSecondary} />
                <Text style={[styles.eventModeButtonText, eventMode === 'viewOnly' && styles.eventModeButtonTextActive]}>View-Only</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      {isAdmin && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Display Options</Text>
          <TouchableOpacity
            style={[styles.card, { alignItems: 'center' }]}
            onPress={() => void setShowTeamAssignment(!showTeamAssignment)}
            activeOpacity={0.7}
            testID="toggle-show-team-assignment"
          >
            <View style={[styles.iconBg, { backgroundColor: showTeamAssignment ? '#DCFCE7' : Colors.surfaceAlt }]}>
              <Users size={24} color={showTeamAssignment ? '#16A34A' : Colors.textSecondary} />
            </View>
            <View style={styles.cardContent}>
              <Text style={styles.cardTitle}>Show Team Assignment</Text>
              <Text style={styles.cardDescription}>
                {showTeamAssignment
                  ? 'Team name is shown on player profiles and pulled from the spreadsheet.'
                  : 'Hidden. Enable to display team info from your spreadsheet on player profiles.'}
              </Text>
            </View>
            <View style={[styles.toggleSwitch, showTeamAssignment && styles.toggleSwitchOn]}>
              <View style={[styles.toggleKnob, showTeamAssignment && styles.toggleKnobOn]} />
            </View>
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Built-in Rules</Text>

        <View style={styles.rulesCard}>
          <View style={styles.rulesHeader}>
            <View style={styles.rulesIconContainer}>
              <Scale size={22} color="#D97706" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.rulesHeaderTitle}>Weight Restrictions</Text>
              <Text style={styles.rulesHeaderSubtitle}>Restricted Division limits</Text>
            </View>
          </View>

          <View style={styles.weightTable}>
            <View style={styles.weightTableHeader}>
              <Text style={styles.weightTableHeaderText}>Age Group</Text>
              <Text style={styles.weightTableHeaderText}>Max Weight</Text>
            </View>
            {[
              { group: 'U8', limit: 100 },
              { group: 'U10', limit: 120 },
              { group: 'U12', limit: 140 },
              { group: 'U14', limit: null as number | null },
            ].map((item, index) => (
              <View key={item.group} style={[styles.weightTableRow, index % 2 === 0 && styles.weightTableRowAlt]}>
                <Text style={styles.weightTableGroup}>{item.group}</Text>
                <Text style={styles.weightTableLimit}>{item.limit !== null ? `${item.limit} lbs` : 'No limit'}</Text>
              </View>
            ))}
          </View>

          <View style={styles.rulesDivider} />

          <View style={styles.rulesOptionsSection}>
            <Text style={styles.rulesOptionsTitle}>When a player exceeds the weight limit in a Restricted division:</Text>
            <View style={styles.rulesOptionRow}>
              <View style={[styles.rulesOptionIcon, { backgroundColor: '#FEF3C7' }]}>
                <Coins size={16} color="#F59E0B" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rulesOptionLabel}>Pennie Player</Text>
                <Text style={styles.rulesOptionDesc}>Touch only — no tackling allowed</Text>
              </View>
            </View>
            <View style={styles.rulesOptionRow}>
              <View style={[styles.rulesOptionIcon, { backgroundColor: '#EDE9FE' }]}>
                <ArrowUp size={16} color="#8B5CF6" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rulesOptionLabel}>Play Up</Text>
                <Text style={styles.rulesOptionDesc}>Move to the next age group with no weight restrictions</Text>
              </View>
            </View>
            <View style={styles.rulesOptionRow}>
              <View style={[styles.rulesOptionIcon, { backgroundColor: '#DBEAFE' }]}>
                <Users size={16} color="#3B82F6" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rulesOptionLabel}>Open Division</Text>
                <Text style={styles.rulesOptionDesc}>Play in the Open division with no weight limit</Text>
              </View>
            </View>
          </View>

          <View style={styles.rulesNote}>
            <AlertTriangle size={14} color="#D97706" />
            <Text style={styles.rulesNoteText}>
              These rules apply only to the Restricted division. Open division has no weight limits.
            </Text>
          </View>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Age Group Rules</Text>

        <View style={styles.ruleLinksCard}>
          <View style={styles.ruleLinksHeader}>
            <View style={[styles.iconBg, { backgroundColor: '#DBEAFE', marginRight: 12 }]}>
              <BookOpen size={22} color="#2563EB" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.ruleLinksTitle}>Division Rulebooks</Text>
              <Text style={styles.ruleLinksSubtitle}>
                {isAdmin
                  ? 'Paste a link (website or Google Drive PDF) for each age group. Tap to open.'
                  : 'Tap an age group to open its rulebook.'}
              </Text>
            </View>
          </View>

          <View style={styles.ruleLinksList}>
            {AGE_GROUPS_FOR_RULES.map((group) => {
              const url = ruleLinks[group];
              const hasLink = !!url;
              return (
                <View key={group} style={styles.ruleLinkRow}>
                  <TouchableOpacity
                    style={[styles.ruleLinkMain, !hasLink && styles.ruleLinkMainEmpty]}
                    onPress={() => {
                      if (hasLink) {
                        void openRulesLink(url, group);
                      } else if (isAdmin) {
                        handleOpenEditRule(group);
                      }
                    }}
                    activeOpacity={hasLink || isAdmin ? 0.7 : 1}
                    disabled={!hasLink && !isAdmin}
                    testID={`rules-open-${group}`}
                  >
                    <View style={styles.ruleLinkBadge}>
                      <Text style={styles.ruleLinkBadgeText}>{group}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.ruleLinkTitle}>
                        {hasLink ? `${group} Rules` : `${group} — No link yet`}
                      </Text>
                      {hasLink ? (
                        <Text style={styles.ruleLinkUrl} numberOfLines={1}>
                          {url}
                        </Text>
                      ) : (
                        <Text style={styles.ruleLinkEmpty}>
                          {isAdmin ? 'Tap to add a link' : 'Not configured'}
                        </Text>
                      )}
                    </View>
                    {hasLink && <ExternalLink size={18} color={Colors.textMuted} />}
                  </TouchableOpacity>

                  {isAdmin && (
                    <TouchableOpacity
                      style={styles.ruleLinkEditButton}
                      onPress={() => handleOpenEditRule(group)}
                      activeOpacity={0.7}
                      testID={`rules-edit-${group}`}
                    >
                      <Pencil size={16} color={Colors.primary} />
                    </TouchableOpacity>
                  )}
                </View>
              );
            })}
          </View>

          {isAdmin && (
            <View style={styles.ruleLinksTip}>
              <Info size={14} color={Colors.textSecondary} />
              <Text style={styles.ruleLinksTipText}>
                Tip: For PDFs, upload to Google Drive and use &quot;Anyone with the link&quot; share URL. Links open in the device browser — no file downloads, keeping the app fast.
              </Text>
            </View>
          )}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Resources</Text>

        <TouchableOpacity
          style={styles.card}
          onPress={() => Linking.openURL('https://docs.google.com/spreadsheets/d/1RwTB0Dnv1fe5Hgz0oa9Y5Y1A245fav9ZKOXzecA6b5Q/edit?usp=sharing')}
          activeOpacity={0.7}
        >
          <View style={[styles.iconBg, { backgroundColor: '#E8F5E9' }]}>
            <FileSpreadsheet size={24} color="#34A853" />
          </View>
          <View style={styles.cardContent}>
            <Text style={styles.cardTitle}>Google Sheet Template</Text>
            <Text style={styles.cardDescription}>
              Use this template when creating your organization's roster spreadsheet
            </Text>
          </View>
          <Link size={20} color={Colors.textMuted} />
        </TouchableOpacity>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>About</Text>

        <View style={styles.infoCard}>
          <View style={styles.infoRow}>
            <Shield size={20} color={Colors.primary} />
            <View style={styles.infoContent}>
              <Text style={styles.infoTitle}>Youth Sports Registration</Text>
              <Text style={styles.infoText}>
                Version 1.0.0{'\n'}
                Built for efficient player check-in and roster management at youth sports events.
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.infoCard}>
          <View style={styles.infoRow}>
            <Info size={20} color={Colors.textSecondary} />
            <View style={styles.infoContent}>
              <Text style={styles.infoTitle}>How to Use</Text>
              <Text style={styles.infoText}>
                • View rosters and filter by club, age, or division{'\n'}
                • Admin/Editor: Enter PIN to unlock check-in and editing{'\n'}
                • Admin: Manage editor access and import players
              </Text>
            </View>
          </View>
        </View>

        <TouchableOpacity
          style={styles.card}
          onPress={() => setShowPrivacyPolicy(true)}
          activeOpacity={0.7}
        >
          <View style={[styles.iconBg, { backgroundColor: Colors.surfaceAlt }]}>
            <FileText size={24} color={Colors.textSecondary} />
          </View>
          <View style={styles.cardContent}>
            <Text style={styles.cardTitle}>Privacy Policy</Text>
            <Text style={styles.cardDescription}>
              View our privacy policy and data practices
            </Text>
          </View>
          <ChevronRight size={20} color={Colors.textMuted} />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.card}
          onPress={() => setShowTermsOfService(true)}
          activeOpacity={0.7}
        >
          <View style={[styles.iconBg, { backgroundColor: Colors.surfaceAlt }]}>
            <FileText size={24} color={Colors.textSecondary} />
          </View>
          <View style={styles.cardContent}>
            <Text style={styles.cardTitle}>Terms of Service</Text>
            <Text style={styles.cardDescription}>
              View the terms and conditions of use
            </Text>
          </View>
          <ChevronRight size={20} color={Colors.textMuted} />
        </TouchableOpacity>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Support</Text>

        <View style={styles.infoCard}>
          <View style={styles.infoRow}>
            <Info size={20} color={Colors.primary} />
            <View style={styles.infoContent}>
              <Text style={styles.infoTitle}>Contact Us</Text>
              <Text style={styles.infoText}>
                For questions, feedback, or support:{"\n"}
                Email: utahsportsrecording@gmail.com{"\n\n"}
                We typically respond within 24-48 hours.
              </Text>
            </View>
          </View>
        </View>
      </View>

      <View style={styles.footer}>
        <Text style={styles.footerText}>
          Contact your administrator for access
        </Text>
      </View>

      <Modal
        visible={showConnectModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={handleCloseSheetsModal}
      >
        <View style={styles.sheetsModalContainer}>
          <View style={styles.sheetsModalHeader}>
            <Text style={styles.sheetsModalHeaderTitle}>Import from Google Sheets</Text>
            <TouchableOpacity style={styles.sheetsCloseButton} onPress={handleCloseSheetsModal}>
              <X size={24} color={Colors.text} />
            </TouchableOpacity>
          </View>

          {sheetsStep === 'url' && (
            <View style={styles.sheetsStepContainer}>
              <View style={[styles.sheetsUploadIcon, { backgroundColor: '#E8F5E9' }]}>
                <FileSpreadsheet size={48} color="#34A853" />
              </View>
              <Text style={styles.sheetsStepTitle}>Import from Google Sheets</Text>
              <Text style={styles.sheetsStepDescription}>
                Paste a link to your publicly shared Google Sheet.
              </Text>

              <View style={styles.sheetsInputContainer}>
                <Text style={styles.sheetsInputLabel}>Spreadsheet URL</Text>
                <TextInput
                  style={styles.sheetsUrlInput}
                  placeholder="https://docs.google.com/spreadsheets/d/..."
                  placeholderTextColor={Colors.textMuted}
                  value={sheetUrl}
                  onChangeText={setSheetUrl}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />
              </View>

              <View style={styles.sheetsFormatInfo}>
                <Text style={styles.sheetsFormatTitle}>How to share your sheet:</Text>
                <Text style={styles.sheetsFormatText}>
                  1. Open your Google Sheet{"\n"}
                  2. Click Share → select &quot;Anyone with the link&quot;{"\n"}
                  3. Set access to &quot;Viewer&quot;{"\n"}
                  4. Copy the link and paste it above
                </Text>
              </View>

              {modalConnectionError && (
                <View style={styles.errorContainer}>
                  <XCircle size={18} color={Colors.error} />
                  <Text style={styles.errorText}>{modalConnectionError}</Text>
                </View>
              )}

              <TouchableOpacity
                style={[styles.sheetsPrimaryButton, (!sheetUrl.trim() || isLoadingSheet) && styles.sheetsPrimaryButtonDisabled]}
                onPress={handleFetchGoogleSheet}
                disabled={!sheetUrl.trim() || isLoadingSheet}
              >
                {isLoadingSheet ? (
                  <ActivityIndicator size="small" color={Colors.white} />
                ) : (
                  <>
                    <FileSpreadsheet size={20} color={Colors.white} />
                    <Text style={styles.sheetsPrimaryButtonText}>Fetch Sheet Data</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          )}

          {sheetsStep === 'mapping' && (
            <View style={styles.sheetsStepContainer}>
              <Text style={styles.sheetsStepTitle}>Map Columns</Text>
              <Text style={styles.sheetsStepDescription}>
                Match your spreadsheet columns to player fields.
              </Text>

              <ScrollView style={styles.sheetsMappingList} showsVerticalScrollIndicator={false}>
                {ALL_FIELDS.map(field => (
                  <View key={field.key} style={styles.sheetsMappingRow}>
                    <View style={styles.sheetsMappingField}>
                      <Text style={styles.sheetsMappingFieldLabel}>
                        {field.label}
                        {field.required && <Text style={styles.sheetsRequiredStar}> *</Text>}
                      </Text>
                    </View>
                    <ArrowRight size={16} color={Colors.textMuted} />
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.sheetsMappingOptions}>
                      <TouchableOpacity
                        style={[
                          styles.sheetsMappingOption,
                          sheetsColumnMapping[field.key] === undefined && styles.sheetsMappingOptionSelected,
                        ]}
                        onPress={() => {
                          const newMapping = { ...sheetsColumnMapping };
                          delete newMapping[field.key];
                          setSheetsColumnMapping(newMapping);
                        }}
                      >
                        <Text style={[
                          styles.sheetsMappingOptionText,
                          sheetsColumnMapping[field.key] === undefined && styles.sheetsMappingOptionTextSelected,
                        ]}>
                          Skip
                        </Text>
                      </TouchableOpacity>
                      {sheetsHeaders.map((header, index) => (
                        <TouchableOpacity
                          key={index}
                          style={[
                            styles.sheetsMappingOption,
                            sheetsColumnMapping[field.key] === index && styles.sheetsMappingOptionSelected,
                          ]}
                          onPress={() => handleSheetsMappingChange(field.key, index)}
                        >
                          <Text
                            style={[
                              styles.sheetsMappingOptionText,
                              sheetsColumnMapping[field.key] === index && styles.sheetsMappingOptionTextSelected,
                            ]}
                            numberOfLines={1}
                          >
                            {header || `Col ${index + 1}`}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </ScrollView>
                  </View>
                ))}
              </ScrollView>

              <View style={styles.sheetsButtonRow}>
                <TouchableOpacity
                  style={styles.sheetsSecondaryButton}
                  onPress={() => setSheetsStep('url')}
                >
                  <Text style={styles.sheetsSecondaryButtonText}>Back</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.sheetsPrimaryButton}
                  onPress={handleSheetsProceedToPreview}
                >
                  <Text style={styles.sheetsPrimaryButtonText}>Preview</Text>
                  <ChevronRight size={18} color={Colors.white} />
                </TouchableOpacity>
              </View>
            </View>
          )}

          {sheetsStep === 'preview' && (
            <View style={styles.sheetsStepContainer}>
              <Text style={styles.sheetsStepTitle}>Preview Import</Text>
              <Text style={styles.sheetsStepDescription}>
                {sheetsParsedPlayers.length} players ready to import
              </Text>

              <FlatList
                data={sheetsParsedPlayers.slice(0, 50)}
                keyExtractor={(_, index) => index.toString()}
                style={styles.sheetsPreviewList}
                renderItem={({ item, index }) => (
                  <View style={styles.sheetsPreviewRow}>
                    <Text style={styles.sheetsPreviewIndex}>{index + 1}</Text>
                    <View style={styles.sheetsPreviewInfo}>
                      <Text style={styles.sheetsPreviewName}>
                        {item.firstName} {item.lastName}
                      </Text>
                      <Text style={styles.sheetsPreviewMeta}>
                        {item.club} • {item.ageGroup} • {item.division}
                      </Text>
                    </View>
                  </View>
                )}
                ListFooterComponent={
                  sheetsParsedPlayers.length > 50 ? (
                    <Text style={styles.sheetsPreviewMore}>
                      +{sheetsParsedPlayers.length - 50} more players...
                    </Text>
                  ) : null
                }
              />

              <View style={styles.sheetsButtonRow}>
                <TouchableOpacity
                  style={styles.sheetsSecondaryButton}
                  onPress={() => setSheetsStep('mapping')}
                >
                  <Text style={styles.sheetsSecondaryButtonText}>Back</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.sheetsPrimaryButton}
                  onPress={handleSheetsImport}
                >
                  <Text style={styles.sheetsPrimaryButtonText}>Import All</Text>
                  <CheckCircle2 size={18} color={Colors.white} />
                </TouchableOpacity>
              </View>
            </View>
          )}

          {sheetsStep === 'importing' && (
            <View style={styles.sheetsStepContainer}>
              <ActivityIndicator size="large" color={Colors.primary} />
              <Text style={styles.sheetsStepTitle}>Importing Players...</Text>
              <Text style={styles.sheetsStepDescription}>
                Please wait while we add {sheetsParsedPlayers.length} players.
              </Text>
            </View>
          )}

          {sheetsStep === 'complete' && (
            <View style={styles.sheetsStepContainer}>
              <View style={styles.sheetsSuccessIcon}>
                <CheckCircle2 size={48} color={Colors.success} />
              </View>
              <Text style={styles.sheetsStepTitle}>Import Complete!</Text>
              <Text style={styles.sheetsStepDescription}>
                Successfully imported {sheetsParsedPlayers.length} players.
              </Text>
              <TouchableOpacity style={styles.sheetsPrimaryButton} onPress={handleCloseSheetsModal}>
                <Text style={styles.sheetsPrimaryButtonText}>Done</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </Modal>

      <Modal
        visible={showLoginModal}
        animationType="slide"
        transparent
        onRequestClose={() => {
          setShowLoginModal(false);
          setPinInput('');
          setVolunteerNameInput('');
          setPinError(null);
        }}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Unlock Editor Access</Text>
              <TouchableOpacity
                onPress={() => {
                  setShowLoginModal(false);
                  setPinInput('');
                  setVolunteerNameInput('');
                  setPinError(null);
                }}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <X size={24} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Your Name</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. Sarah Johnson"
                placeholderTextColor={Colors.textMuted}
                value={volunteerNameInput}
                onChangeText={setVolunteerNameInput}
                autoCapitalize="words"
                autoCorrect={false}
                maxLength={40}
                testID="volunteer-name-input"
              />
              <Text style={styles.inputHelper}>
                The admin will see this name next to your editor session.
              </Text>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Editor PIN</Text>
              <View style={styles.pinInputContainer}>
                <TextInput
                  style={styles.pinInput}
                  placeholder="Paste the PIN your admin shared"
                  placeholderTextColor={Colors.textMuted}
                  value={pinInput}
                  onChangeText={setPinInput}
                  secureTextEntry={!showPin}
                  keyboardType="number-pad"
                  maxLength={8}
                />
                <TouchableOpacity
                  onPress={() => setShowPin(!showPin)}
                  style={styles.eyeButton}
                >
                  {showPin ? (
                    <EyeOff size={20} color={Colors.textSecondary} />
                  ) : (
                    <Eye size={20} color={Colors.textSecondary} />
                  )}
                </TouchableOpacity>
              </View>
            </View>

            {pinError && (
              <View style={styles.errorContainer}>
                <XCircle size={18} color={Colors.error} />
                <Text style={styles.errorText}>{pinError}</Text>
              </View>
            )}

            <TouchableOpacity
              style={styles.connectButton}
              onPress={handleLogin}
              activeOpacity={0.7}
            >
              <Unlock size={20} color={Colors.white} />
              <Text style={styles.connectButtonText}>Unlock</Text>
            </TouchableOpacity>

            <View style={styles.modalInfo}>
              <Text style={styles.modalInfoText}>
                Ask your admin to open Settings → Editor Access Management → "Generate Editor PIN" and share the PIN it produces. (The admin's own admin PIN also works on the device that created this org.)
              </Text>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={showChangePinModal}
        animationType="slide"
        transparent
        onRequestClose={() => {
          setShowChangePinModal(false);
          setCurrentPinInput('');
          setNewPinInput('');
          setPinError(null);
        }}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Change Admin PIN</Text>
              <TouchableOpacity
                onPress={() => {
                  setShowChangePinModal(false);
                  setCurrentPinInput('');
                  setNewPinInput('');
                  setPinError(null);
                }}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <X size={24} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Current Admin PIN</Text>
              <TextInput
                style={styles.input}
                placeholder="Enter current PIN"
                placeholderTextColor={Colors.textMuted}
                value={currentPinInput}
                onChangeText={setCurrentPinInput}
                secureTextEntry
                keyboardType="number-pad"
                maxLength={8}
              />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>New Admin PIN</Text>
              <TextInput
                style={styles.input}
                placeholder="Enter new PIN (min 4 digits)"
                placeholderTextColor={Colors.textMuted}
                value={newPinInput}
                onChangeText={setNewPinInput}
                secureTextEntry
                keyboardType="number-pad"
                maxLength={8}
              />
            </View>

            {pinError && (
              <View style={styles.errorContainer}>
                <XCircle size={18} color={Colors.error} />
                <Text style={styles.errorText}>{pinError}</Text>
              </View>
            )}

            <TouchableOpacity
              style={styles.connectButton}
              onPress={handleChangeAdminPin}
              activeOpacity={0.7}
            >
              <Key size={20} color={Colors.white} />
              <Text style={styles.connectButtonText}>Change Admin PIN</Text>
            </TouchableOpacity>

            <View style={styles.modalInfo}>
              <Text style={styles.modalInfoText}>
                Changing the admin PIN will log out all other admin sessions.
              </Text>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={showEditorPinModal}
        animationType="slide"
        transparent
        onRequestClose={() => {
          setShowEditorPinModal(false);
          setAdminVerifyPin('');
          setEditorPinInput('');
          setCustomEditorPinInput('');
          setEditorPinMode('auto');
          setPinError(null);
        }}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Generate Editor PIN</Text>
              <TouchableOpacity
                onPress={() => {
                  setShowEditorPinModal(false);
                  setAdminVerifyPin('');
                  setEditorPinInput('');
                  setCustomEditorPinInput('');
                  setEditorPinMode('auto');
                  setPinError(null);
                }}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <X size={24} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>PIN Type</Text>
              <View style={styles.pinModeRow}>
                <TouchableOpacity
                  style={[
                    styles.pinModeButton,
                    editorPinMode === 'auto' && styles.pinModeButtonActive,
                  ]}
                  onPress={() => {
                    setEditorPinMode('auto');
                    setPinError(null);
                  }}
                  activeOpacity={0.7}
                  testID="editor-pin-mode-auto"
                >
                  <Text
                    style={[
                      styles.pinModeButtonText,
                      editorPinMode === 'auto' && styles.pinModeButtonTextActive,
                    ]}
                  >
                    Auto-generate
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.pinModeButton,
                    editorPinMode === 'custom' && styles.pinModeButtonActive,
                  ]}
                  onPress={() => {
                    setEditorPinMode('custom');
                    setPinError(null);
                  }}
                  activeOpacity={0.7}
                  testID="editor-pin-mode-custom"
                >
                  <Text
                    style={[
                      styles.pinModeButtonText,
                      editorPinMode === 'custom' && styles.pinModeButtonTextActive,
                    ]}
                  >
                    Custom PIN
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            {editorPinMode === 'custom' && (
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>Custom PIN (4-10 digits)</Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. 482931"
                  placeholderTextColor={Colors.textMuted}
                  value={customEditorPinInput}
                  onChangeText={(t) => setCustomEditorPinInput(t.replace(/[^0-9]/g, ''))}
                  keyboardType="number-pad"
                  maxLength={10}
                  testID="editor-pin-custom-input"
                />
              </View>
            )}

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Label (optional)</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. Volunteer Lead, Front Desk"
                placeholderTextColor={Colors.textMuted}
                value={editorPinInput}
                onChangeText={setEditorPinInput}
                autoCapitalize="words"
                maxLength={40}
              />
            </View>

            {pinError && (
              <View style={styles.errorContainer}>
                <XCircle size={18} color={Colors.error} />
                <Text style={styles.errorText}>{pinError}</Text>
              </View>
            )}

            <TouchableOpacity
              style={styles.connectButton}
              onPress={handleSetEditorPin}
              activeOpacity={0.7}
              testID="confirm-generate-editor-pin"
            >
              <Key size={20} color={Colors.white} />
              <Text style={styles.connectButtonText}>
                {editorPinMode === 'custom' ? 'Create PIN' : 'Generate PIN'}
              </Text>
            </TouchableOpacity>

            <View style={styles.modalInfo}>
              <Text style={styles.modalInfoText}>
                {editorPinMode === 'custom'
                  ? 'Choose a 4-10 digit PIN you can remember. It is copied to your clipboard so you can share it with helpers — they enter it under Settings → Unlock Access on their device. Valid for 8 hours; any previously issued PIN is automatically revoked.'
                  : 'The app generates a random 6-digit PIN and copies it to your clipboard. Share that PIN with your helper — they enter it under Settings → Unlock Access on their own device. The PIN is valid for 8 hours and any previously issued PIN is automatically revoked.'}
              </Text>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={showRevokeModal}
        animationType="slide"
        transparent
        onRequestClose={() => {
          setShowRevokeModal(false);
          setAdminVerifyPin('');
          setPinError(null);
        }}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Revoke All Editor Access</Text>
              <TouchableOpacity
                onPress={() => {
                  setShowRevokeModal(false);
                  setAdminVerifyPin('');
                  setPinError(null);
                }}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <X size={24} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>

            {pinError && (
              <View style={styles.errorContainer}>
                <XCircle size={18} color={Colors.error} />
                <Text style={styles.errorText}>{pinError}</Text>
              </View>
            )}

            <TouchableOpacity
              style={[styles.connectButton, styles.dangerButton]}
              onPress={handleConfirmDisableEditor}
              activeOpacity={0.7}
            >
              <UserX size={20} color={Colors.white} />
              <Text style={styles.connectButtonText}>Revoke Now</Text>
            </TouchableOpacity>

            <View style={styles.modalInfo}>
              <Text style={styles.modalInfoText}>
                This immediately invalidates every active editor PIN and session. Every editor device will drop back to viewer-only on its next sync (within ~30 seconds). Generate a fresh PIN to bring helpers back.
              </Text>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={showJoinOrgModal}
        animationType="slide"
        transparent
        onRequestClose={() => {
          setShowJoinOrgModal(false);
          setOrgCodeInput('');
          setOrgError(null);
        }}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <TouchableOpacity
            style={styles.modalOverlayDismiss}
            activeOpacity={1}
            onPress={() => {
              setShowJoinOrgModal(false);
              setOrgCodeInput('');
              setOrgError(null);
            }}
          />
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Join Organization</Text>
              <TouchableOpacity
                onPress={() => {
                  setShowJoinOrgModal(false);
                  setOrgCodeInput('');
                  setOrgError(null);
                }}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <X size={24} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Organization Code</Text>
              <TextInput
                style={[styles.input, styles.codeInput]}
                placeholder="Enter 6-character code"
                placeholderTextColor={Colors.textMuted}
                value={orgCodeInput}
                onChangeText={(text) => setOrgCodeInput(text.toUpperCase())}
                autoCapitalize="characters"
                maxLength={6}
                autoFocus
              />
            </View>

            {orgError && (
              <View style={styles.errorContainer}>
                <XCircle size={18} color={Colors.error} />
                <Text style={styles.errorText}>{orgError}</Text>
              </View>
            )}

            <TouchableOpacity
              style={styles.connectButton}
              onPress={handleJoinOrg}
              activeOpacity={0.7}
            >
              <LogIn size={20} color={Colors.white} />
              <Text style={styles.connectButtonText}>Join</Text>
            </TouchableOpacity>

            <View style={styles.modalInfo}>
              <Text style={styles.modalInfoText}>
                Ask your organization admin for the invite code
              </Text>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={showCreateOrgModal}
        animationType="slide"
        transparent
        onRequestClose={() => {
          setShowCreateOrgModal(false);
          setNewOrgName('');
          setOrgError(null);
        }}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <TouchableOpacity
            style={styles.modalOverlayDismiss}
            activeOpacity={1}
            onPress={() => {
              setShowCreateOrgModal(false);
              setNewOrgName('');
              setOrgError(null);
            }}
          />
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Create Organization</Text>
              <TouchableOpacity
                onPress={() => {
                  setShowCreateOrgModal(false);
                  setNewOrgName('');
                  setOrgError(null);
                }}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <X size={24} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Organization Name</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g., Utah Little Rugby"
                placeholderTextColor={Colors.textMuted}
                value={newOrgName}
                onChangeText={setNewOrgName}
                autoFocus
              />
            </View>

            {orgError && (
              <View style={styles.errorContainer}>
                <XCircle size={18} color={Colors.error} />
                <Text style={styles.errorText}>{orgError}</Text>
              </View>
            )}

            <TouchableOpacity
              style={styles.connectButton}
              onPress={handleCreateOrg}
              activeOpacity={0.7}
            >
              <Building2 size={20} color={Colors.white} />
              <Text style={styles.connectButtonText}>Create Organization</Text>
            </TouchableOpacity>

            <View style={styles.modalInfo}>
              <Text style={styles.modalInfoText}>
                You will be the admin of this organization and can invite volunteers
              </Text>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={showMyOrgsModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowMyOrgsModal(false)}
        onShow={() => {
          (async () => {
            if (organizations.length === 0) return;
            console.log('[MyOrgsModal] auto-syncing all orgs on open...');
            setSyncAllStatus('syncing');
            setSyncAllMessage(null);
            let okCount = 0;
            let failCount = 0;
            let lastErr: string | null = null;
            for (const org of organizations) {
              const res = await pushOrgToCloud(org.id);
              if (res.success) {
                okCount += 1;
              } else {
                failCount += 1;
                lastErr = res.message;
              }
            }
            if (failCount === 0) {
              setSyncAllStatus('done');
              setSyncAllMessage(`All ${okCount} organization${okCount === 1 ? '' : 's'} synced to cloud. Invite codes will work on any device.`);
            } else {
              setSyncAllStatus('error');
              setSyncAllMessage(`${okCount} synced, ${failCount} failed. ${lastErr ?? ''}`);
            }
          })().catch((e) => {
            console.log('[MyOrgsModal] auto-sync error', e);
            setSyncAllStatus('error');
            setSyncAllMessage(e instanceof Error ? e.message : String(e));
          });
        }}
      >
        <View style={styles.sheetsModalContainer}>
          <View style={styles.sheetsModalHeader}>
            <TouchableOpacity
              style={styles.sheetsBackButton}
              onPress={() => setShowMyOrgsModal(false)}
            >
              <ChevronLeft size={24} color={Colors.text} />
            </TouchableOpacity>
            <Text style={styles.sheetsModalHeaderTitle}>My Organizations</Text>
            <View style={styles.sheetsHeaderSpacer} />
          </View>

          <ScrollView style={styles.importedSheetsContent} contentContainerStyle={{ paddingBottom: 40 }}>
            <Text style={styles.importedSheetsDescription}>
              Organizations you have created or joined. You can only delete organizations where you are the admin/owner.
            </Text>

            {organizations.length > 0 && (
              <View style={styles.syncAllBanner} testID="sync-all-banner">
                <View style={styles.syncAllBannerHeader}>
                  <RefreshCw
                    size={18}
                    color={
                      syncAllStatus === 'error'
                        ? Colors.error
                        : syncAllStatus === 'done'
                        ? Colors.primary
                        : Colors.primary
                    }
                  />
                  <Text style={styles.syncAllBannerTitle}>
                    {syncAllStatus === 'syncing'
                      ? 'Syncing organizations to cloud…'
                      : syncAllStatus === 'done'
                      ? 'Organizations synced to cloud'
                      : syncAllStatus === 'error'
                      ? 'Some organizations did not sync'
                      : 'Cloud sync'}
                  </Text>
                </View>
                <Text style={styles.syncAllBannerText}>
                  {syncAllMessage ??
                    'Tap “Sync All to Cloud” to make every invite code work for testers on other devices.'}
                </Text>
                <TouchableOpacity
                  style={[
                    styles.syncAllBannerButton,
                    syncAllStatus === 'syncing' && styles.syncAllBannerButtonDisabled,
                  ]}
                  disabled={syncAllStatus === 'syncing'}
                  onPress={async () => {
                    setSyncAllStatus('syncing');
                    setSyncAllMessage(null);
                    let okCount = 0;
                    let failCount = 0;
                    let lastErr: string | null = null;
                    for (const org of organizations) {
                      const res = await pushOrgToCloud(org.id);
                      if (res.success) okCount += 1;
                      else {
                        failCount += 1;
                        lastErr = res.message;
                      }
                    }
                    if (failCount === 0) {
                      setSyncAllStatus('done');
                      setSyncAllMessage(
                        `All ${okCount} organization${okCount === 1 ? '' : 's'} synced to cloud. Invite codes will work on any device.`,
                      );
                      Alert.alert(
                        'Synced to Cloud',
                        `All ${okCount} organization${okCount === 1 ? '' : 's'} synced. Testers can now join with the invite code.`,
                      );
                    } else {
                      setSyncAllStatus('error');
                      setSyncAllMessage(`${okCount} synced, ${failCount} failed. ${lastErr ?? ''}`);
                      Alert.alert('Sync partially failed', `${okCount} synced, ${failCount} failed.\n\n${lastErr ?? ''}`);
                    }
                  }}
                  activeOpacity={0.7}
                  testID="sync-all-orgs-button"
                >
                  <RefreshCw size={16} color={Colors.white} />
                  <Text style={styles.syncAllBannerButtonText}>
                    {syncAllStatus === 'syncing' ? 'Syncing…' : 'Sync All to Cloud'}
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            {organizations.map((org) => {
              const orgMembers = members.filter(m => m.orgId === org.id);
              const isOrgOwner = orgMembers.some(
                m => (m.role === 'owner' || m.role === 'admin') && m.userId.startsWith('owner-')
              );
              const canDelete = isOrgOwner || isAdmin;
              const isCurrent = currentOrg?.id === org.id;

              const expiresAt = org.expiresAt ? new Date(org.expiresAt) : null;
              const now = new Date();
              const isExpired = expiresAt ? expiresAt < now : false;
              const daysRemaining = expiresAt ? Math.ceil((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)) : null;
              const isExpiringSoon = daysRemaining !== null && daysRemaining > 0 && daysRemaining <= 14;

              return (
                <View key={org.id} style={[styles.myOrgCard, isCurrent && styles.myOrgCardActive]}>
                  <View style={styles.myOrgHeader}>
                    <View style={[styles.myOrgIcon, { backgroundColor: org.primaryColor + '20' }]}>
                      <Building2 size={22} color={org.primaryColor} />
                    </View>
                    <View style={styles.myOrgInfo}>
                      <Text style={styles.myOrgName}>{org.name}</Text>
                      <Text style={styles.myOrgMeta}>
                        {orgMembers.length} member{orgMembers.length !== 1 ? 's' : ''} • Created {new Date(org.createdAt).toLocaleDateString()}
                      </Text>
                      <View style={styles.orgBadgeRow}>
                        {isCurrent && (
                          <View style={styles.currentBadge}>
                            <Text style={styles.currentBadgeText}>Current</Text>
                          </View>
                        )}
                        {isExpired ? (
                          <View style={styles.expiredBadge}>
                            <Text style={styles.expiredBadgeText}>Expired</Text>
                          </View>
                        ) : isExpiringSoon ? (
                          <View style={styles.expiringSoonBadge}>
                            <Text style={styles.expiringSoonBadgeText}>{daysRemaining}d left</Text>
                          </View>
                        ) : (
                          <View style={styles.activeBadge}>
                            <Text style={styles.activeBadgeText}>Active</Text>
                          </View>
                        )}
                      </View>
                    </View>
                  </View>

                  <View style={styles.orgShareCodeCard}>
                    <View style={styles.orgShareCodeHeader}>
                      <Text style={styles.orgShareCodeLabel}>SHARE CODE</Text>
                      {expiresAt && !isExpired && (
                        <View style={styles.orgExpiryRow}>
                          <Clock size={12} color={isExpiringSoon ? '#D97706' : Colors.textMuted} />
                          <Text style={[styles.orgExpiryText, isExpiringSoon && styles.orgExpiryTextWarning]}>
                            Expires {expiresAt.toLocaleDateString()}
                          </Text>
                        </View>
                      )}
                    </View>
                    <View style={styles.orgShareCodeValueRow}>
                      <Text style={[styles.orgShareCodeValue, isExpired && styles.orgShareCodeValueExpired]}>
                        {org.code}
                      </Text>
                      <TouchableOpacity
                        style={styles.orgShareCopyBtn}
                        onPress={async () => {
                          await Clipboard.setStringAsync(org.code);
                          Alert.alert('Copied!', `Code ${org.code} copied to clipboard.`);
                        }}
                        activeOpacity={0.7}
                      >
                        <Copy size={16} color={Colors.primary} />
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.orgShareShareBtn}
                        onPress={async () => {
                          const result = await pushOrgToCloud(org.id);
                          const message = `Join ${org.name} on the Youth Sports Registration app!\n\nOrganization Code: ${org.code}\n\nEnter this code in the app to join our organization.`;
                          if (!result.success) {
                            Alert.alert('Share Code (not synced)', `${message}\n\nWarning: ${result.message}`);
                          } else {
                            Alert.alert('Share Code', message);
                          }
                        }}
                        activeOpacity={0.7}
                      >
                        <Share2 size={16} color={Colors.primary} />
                      </TouchableOpacity>
                    </View>
                    <TouchableOpacity
                      style={styles.orgSyncCloudBtn}
                      onPress={async () => {
                        const result = await pushOrgToCloud(org.id);
                        Alert.alert(result.success ? 'Synced to Cloud' : 'Sync Failed', result.message);
                      }}
                      activeOpacity={0.7}
                      testID={`sync-org-${org.code}`}
                    >
                      <RefreshCw size={14} color={Colors.primary} />
                      <Text style={styles.orgSyncCloudBtnText}>Sync to Cloud</Text>
                    </TouchableOpacity>
                    <Text style={styles.orgShareCodeHint}>
                      Share this code with others to let them join this organization. If a tester can&apos;t join, tap &quot;Sync to Cloud&quot; above.
                    </Text>
                  </View>

                  <View style={styles.myOrgActions}>
                    {!isCurrent && (
                      <TouchableOpacity
                        style={styles.myOrgActionButton}
                        onPress={() => {
                          void selectOrg(org.id);
                          setShowMyOrgsModal(false);
                          Alert.alert('Switched', `Now using ${org.name}.`);
                        }}
                        activeOpacity={0.7}
                      >
                        <LogIn size={16} color={Colors.primary} />
                        <Text style={styles.myOrgActionText}>Switch To</Text>
                      </TouchableOpacity>
                    )}

                    {!canDelete && (
                      <TouchableOpacity
                        style={styles.myOrgLeaveButton}
                        onPress={() => {
                          Alert.alert(
                            'Leave Organization?',
                            `You will lose access to "${org.name}" on this device. You can re-join later using the invite code.`,
                            [
                              { text: 'Cancel', style: 'cancel' },
                              {
                                text: 'Leave',
                                style: 'destructive',
                                onPress: async () => {
                                  const ok = await leaveOrg(org.id);
                                  if (ok) {
                                    Alert.alert('Left Organization', `You have left "${org.name}".`);
                                  } else {
                                    Alert.alert('Error', 'Failed to leave organization.');
                                  }
                                },
                              },
                            ]
                          );
                        }}
                        activeOpacity={0.7}
                      >
                        <LogIn size={16} color={Colors.warning} style={{ transform: [{ rotate: '180deg' }] }} />
                        <Text style={styles.myOrgLeaveText}>Leave</Text>
                      </TouchableOpacity>
                    )}

                    {canDelete && (
                      <TouchableOpacity
                        style={styles.myOrgDeleteButton}
                        onPress={() => handleDeleteOrg(org.id, org.name)}
                        activeOpacity={0.7}
                      >
                        <Trash2 size={16} color={Colors.error} />
                        <Text style={styles.myOrgDeleteText}>Delete</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              );
            })}

            {organizations.length === 0 && (
              <View style={styles.emptyOrgsContainer}>
                <Building2 size={40} color={Colors.textMuted} />
                <Text style={styles.emptyOrgsTitle}>No Organizations</Text>
                <Text style={styles.emptyOrgsText}>Create or join an organization to get started.</Text>
              </View>
            )}
          </ScrollView>
        </View>
      </Modal>

      <Modal
        visible={showPrivacyPolicy}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowPrivacyPolicy(false)}
      >
        <View style={styles.privacyModalContainer}>
          <View style={styles.privacyModalHeader}>
            <Text style={styles.privacyModalTitle}>Privacy Policy</Text>
            <TouchableOpacity
              style={styles.privacyCloseButton}
              onPress={() => setShowPrivacyPolicy(false)}
            >
              <X size={24} color={Colors.text} />
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.privacyContent} showsVerticalScrollIndicator={false}>
            <Text style={styles.privacyLastUpdated}>Last Updated: January 22, 2025</Text>
            
            <Text style={styles.privacySection}>1. Introduction</Text>
            <Text style={styles.privacyText}>
              Utah Little Rugby (&quot;we,&quot; &quot;our,&quot; or &quot;us&quot;) operates the Youth Sports Registration mobile application (the &quot;App&quot;). This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our App.
            </Text>
            <Text style={styles.privacyText}>
              Please read this Privacy Policy carefully. By using the App, you agree to the collection and use of information in accordance with this policy.
            </Text>

            <Text style={styles.privacySection}>2. Information We Collect</Text>
            <Text style={styles.privacySubsection}>2.1 Information You Provide</Text>
            <Text style={styles.privacyText}>
              We collect information that you voluntarily provide when using the App, including:{"\n"}
              • Player registration information (name, date of birth, age group, division){"\n"}
              • Parent/guardian contact information (name, phone number){"\n"}
              • Club and team affiliations{"\n"}
              • Weight information for age/division verification{"\n"}
              • Photos for player identification (if provided)
            </Text>

            <Text style={styles.privacySubsection}>2.2 Information Collected Automatically</Text>
            <Text style={styles.privacyText}>
              When you use the App, we may automatically collect:{"\n"}
              • Device information (device type, operating system){"\n"}
              • App usage data and check-in timestamps{"\n"}
              • Error logs for troubleshooting purposes
            </Text>

            <Text style={styles.privacySection}>3. How We Use Your Information</Text>
            <Text style={styles.privacyText}>
              We use the collected information to:{"\n"}
              • Facilitate player registration and check-in at events{"\n"}
              • Verify player eligibility based on age and weight requirements{"\n"}
              • Manage rosters and team assignments{"\n"}
              • Communicate with parents/guardians regarding events{"\n"}
              • Improve and maintain the App{"\n"}
              • Comply with legal obligations and safety requirements
            </Text>

            <Text style={styles.privacySection}>4. Children&apos;s Privacy (COPPA Compliance)</Text>
            <Text style={styles.privacyText}>
              Our App is designed for youth sports management and inherently involves the collection of information about children under 13. We take children&apos;s privacy very seriously and comply with the Children&apos;s Online Privacy Protection Act (COPPA).
            </Text>
            <Text style={styles.privacyText}>
              • We collect only the minimum information necessary for sports registration and safety{"\n"}
              • Information about minors is provided by parents/guardians or authorized organization administrators{"\n"}
              • Parents/guardians may review, correct, or request deletion of their child&apos;s information by contacting us{"\n"}
              • We do not condition participation on the disclosure of more information than reasonably necessary{"\n"}
              • We do not share children&apos;s information with third parties for marketing purposes
            </Text>

            <Text style={styles.privacySection}>5. Data Storage and Security</Text>
            <Text style={styles.privacyText}>
              We implement appropriate technical and organizational measures to protect your personal information:{"\n"}
              • Data is stored securely using industry-standard encryption{"\n"}
              • Access to player data is restricted through PIN-based authentication{"\n"}
              • Organization administrators control who has access to their data{"\n"}
              • We regularly review and update our security practices
            </Text>
            <Text style={styles.privacyText}>
              While we strive to protect your information, no method of electronic storage is 100% secure. We cannot guarantee absolute security.
            </Text>

            <Text style={styles.privacySection}>6. Data Sharing and Disclosure</Text>
            <Text style={styles.privacyText}>
              We do not sell your personal information. We may share information:{"\n"}
              • With organization administrators and authorized volunteers for event management{"\n"}
              • When required by law or to respond to legal process{"\n"}
              • To protect the safety of players, staff, or the public{"\n"}
              • With service providers who assist in App operations (under strict confidentiality agreements)
            </Text>

            <Text style={styles.privacySection}>7. Third-Party Services</Text>
            <Text style={styles.privacyText}>
              The App may integrate with third-party services such as Google Sheets for data import. When you connect to third-party services, their privacy policies apply to your use of those services. We encourage you to review their privacy policies.
            </Text>

            <Text style={styles.privacySection}>8. Data Retention</Text>
            <Text style={styles.privacyText}>
              We retain personal information only for as long as necessary to fulfill the purposes outlined in this Privacy Policy, unless a longer retention period is required by law. Registration data is typically retained for the duration of the sports season and may be deleted upon request.
            </Text>

            <Text style={styles.privacySection}>9. Your Rights and Choices</Text>
            <Text style={styles.privacyText}>
              You have the right to:{"\n"}
              • Access the personal information we hold about you or your child{"\n"}
              • Request correction of inaccurate information{"\n"}
              • Request deletion of personal information{"\n"}
              • Withdraw consent for data processing{"\n"}
              • Request a copy of your data in a portable format
            </Text>
            <Text style={styles.privacyText}>
              To exercise these rights, please contact your organization administrator or reach out to us directly.
            </Text>

            <Text style={styles.privacySection}>10. California Privacy Rights</Text>
            <Text style={styles.privacyText}>
              California residents may have additional rights under the California Consumer Privacy Act (CCPA), including the right to know what personal information is collected and how it is used, and the right to request deletion of personal information.
            </Text>

            <Text style={styles.privacySection}>11. Changes to This Privacy Policy</Text>
            <Text style={styles.privacyText}>
              We may update this Privacy Policy from time to time. We will notify you of any changes by posting the new Privacy Policy in the App and updating the Last Updated date. You are advised to review this Privacy Policy periodically.
            </Text>

            <Text style={styles.privacySection}>12. Contact Us</Text>
            <Text style={styles.privacyText}>
              If you have questions about this Privacy Policy or our data practices, please contact us:{"\n\n"}
              Utah Little Rugby{"\n"}
              Email: utahsportsrecording@gmail.com{"\n\n"}
              For questions about your child&apos;s information or to exercise your parental rights under COPPA, please contact your organization administrator or email us at the address above.
            </Text>

            <View style={styles.privacyFooter}>
              <Text style={styles.privacyFooterText}>
                By using this App, you acknowledge that you have read and understood this Privacy Policy.
              </Text>
            </View>
          </ScrollView>
        </View>
      </Modal>

      <Modal
        visible={showTermsOfService}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowTermsOfService(false)}
      >
        <View style={styles.privacyModalContainer}>
          <View style={styles.privacyModalHeader}>
            <Text style={styles.privacyModalTitle}>Terms of Service</Text>
            <TouchableOpacity
              style={styles.privacyCloseButton}
              onPress={() => setShowTermsOfService(false)}
            >
              <X size={24} color={Colors.text} />
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.privacyContent} showsVerticalScrollIndicator={false}>
            <Text style={styles.privacyLastUpdated}>Last Updated: January 22, 2025</Text>
            
            <Text style={styles.privacySection}>1. Acceptance of Terms</Text>
            <Text style={styles.privacyText}>
              By accessing or using the Utah Little Rugby mobile application (the &quot;App&quot;), you agree to be bound by these Terms of Service (&quot;Terms&quot;). If you do not agree to these Terms, please do not use the App.
            </Text>

            <Text style={styles.privacySection}>2. Description of Service</Text>
            <Text style={styles.privacyText}>
              The App provides youth sports registration and player check-in management services for Utah Little Rugby events. The App allows authorized users to:{"\n"}
              • Manage player rosters and registrations{"\n"}
              • Check in players at events{"\n"}
              • Verify player eligibility based on age and weight{"\n"}
              • Import player data from external sources{"\n"}
              • Manage organization access and permissions
            </Text>

            <Text style={styles.privacySection}>3. User Accounts and Access</Text>
            <Text style={styles.privacyText}>
              Access to certain features requires authentication via PIN codes. You are responsible for:{"\n"}
              • Maintaining the confidentiality of your access credentials{"\n"}
              • All activities that occur under your access{"\n"}
              • Notifying your organization administrator immediately of any unauthorized use{"\n"}
              • Ensuring that only authorized personnel have access to sensitive player information
            </Text>

            <Text style={styles.privacySection}>4. Acceptable Use</Text>
            <Text style={styles.privacyText}>
              You agree to use the App only for lawful purposes and in accordance with these Terms. You agree NOT to:{"\n"}
              • Use the App for any purpose other than youth sports management{"\n"}
              • Share access credentials with unauthorized individuals{"\n"}
              • Attempt to gain unauthorized access to any portion of the App{"\n"}
              • Use the App to collect or store personal information beyond what is necessary for sports registration{"\n"}
              • Misuse, alter, or falsify player information{"\n"}
              • Use the App in any way that violates applicable laws or regulations
            </Text>

            <Text style={styles.privacySection}>5. Player Data and Privacy</Text>
            <Text style={styles.privacyText}>
              The App handles sensitive information about minors. All users must:{"\n"}
              • Comply with our Privacy Policy{"\n"}
              • Handle player information with appropriate care and confidentiality{"\n"}
              • Only access player information necessary for their role{"\n"}
              • Not share player information outside the App without proper authorization{"\n"}
              • Report any data breaches or security concerns immediately
            </Text>

            <Text style={styles.privacySection}>6. Intellectual Property</Text>
            <Text style={styles.privacyText}>
              The App and its original content, features, and functionality are owned by Utah Little Rugby and are protected by international copyright, trademark, and other intellectual property laws. You may not copy, modify, distribute, sell, or lease any part of the App without express written permission.
            </Text>

            <Text style={styles.privacySection}>7. Third-Party Services</Text>
            <Text style={styles.privacyText}>
              The App may integrate with third-party services such as Google Sheets. Your use of such services is subject to their respective terms of service. We are not responsible for the content, privacy policies, or practices of third-party services.
            </Text>

            <Text style={styles.privacySection}>8. Disclaimer of Warranties</Text>
            <Text style={styles.privacyText}>
              THE APP IS PROVIDED &quot;AS IS&quot; AND &quot;AS AVAILABLE&quot; WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED. WE DO NOT WARRANT THAT THE APP WILL BE UNINTERRUPTED, SECURE, OR ERROR-FREE. USE OF THE APP IS AT YOUR OWN RISK.
            </Text>

            <Text style={styles.privacySection}>9. Limitation of Liability</Text>
            <Text style={styles.privacyText}>
              TO THE MAXIMUM EXTENT PERMITTED BY LAW, UTAH LITTLE RUGBY SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS OR REVENUES, WHETHER INCURRED DIRECTLY OR INDIRECTLY, OR ANY LOSS OF DATA, USE, GOODWILL, OR OTHER INTANGIBLE LOSSES RESULTING FROM YOUR USE OF THE APP.
            </Text>

            <Text style={styles.privacySection}>10. Indemnification</Text>
            <Text style={styles.privacyText}>
              You agree to indemnify and hold harmless Utah Little Rugby, its officers, directors, employees, and agents from any claims, damages, losses, liabilities, and expenses (including attorneys&apos; fees) arising out of or related to your use of the App or violation of these Terms.
            </Text>

            <Text style={styles.privacySection}>11. Termination</Text>
            <Text style={styles.privacyText}>
              We may terminate or suspend your access to the App immediately, without prior notice or liability, for any reason, including if you breach these Terms. Upon termination, your right to use the App will immediately cease.
            </Text>

            <Text style={styles.privacySection}>12. Changes to Terms</Text>
            <Text style={styles.privacyText}>
              We reserve the right to modify these Terms at any time. We will notify users of any material changes by posting the new Terms in the App. Your continued use of the App after such modifications constitutes your acceptance of the revised Terms.
            </Text>

            <Text style={styles.privacySection}>13. Governing Law</Text>
            <Text style={styles.privacyText}>
              These Terms shall be governed by and construed in accordance with the laws of the State of Utah, without regard to its conflict of law provisions.
            </Text>

            <Text style={styles.privacySection}>14. Contact Information</Text>
            <Text style={styles.privacyText}>
              If you have any questions about these Terms, please contact us:{"\n\n"}
              Utah Little Rugby{"\n"}
              Email: utahsportsrecording@gmail.com
            </Text>

            <View style={styles.privacyFooter}>
              <Text style={styles.privacyFooterText}>
                By using this App, you acknowledge that you have read, understood, and agree to be bound by these Terms of Service.
              </Text>
            </View>
          </ScrollView>
        </View>
      </Modal>

      <Modal
        visible={showImportedSheetsModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowImportedSheetsModal(false)}
      >
        <View style={styles.sheetsModalContainer}>
          <View style={styles.sheetsModalHeader}>
            <TouchableOpacity
              style={styles.sheetsBackButton}
              onPress={() => setShowImportedSheetsModal(false)}
            >
              <ChevronLeft size={24} color={Colors.text} />
            </TouchableOpacity>
            <Text style={styles.sheetsModalHeaderTitle}>Imported Sheets</Text>
            <View style={styles.sheetsHeaderSpacer} />
          </View>

          <ScrollView style={styles.importedSheetsContent} contentContainerStyle={{ paddingBottom: 40 }}>
            <Text style={styles.importedSheetsDescription}>
              These are all the Google Sheets you&apos;ve imported. Share access codes with users who need to re-import data. Default permissions are view-only.
            </Text>

            {importedSheets.map((sheet) => (
              <View key={sheet.id} style={styles.importedSheetCard}>
                <View style={styles.importedSheetHeader}>
                  <FileSpreadsheet size={24} color="#34A853" />
                  <View style={styles.importedSheetInfo}>
                    <Text style={styles.importedSheetTitle}>{sheet.title}</Text>
                    <Text style={styles.importedSheetMeta}>
                      {sheet.playerCount} players • Imported {new Date(sheet.importedAt).toLocaleDateString()}
                    </Text>
                  </View>
                </View>

                <View style={styles.accessCodeSection}>
                  <Text style={styles.accessCodeLabel}>Access Code</Text>
                  <View style={styles.accessCodeRow}>
                    <Text style={styles.accessCodeValue}>{sheet.accessCode}</Text>
                    <TouchableOpacity
                      style={styles.accessCodeCopyButton}
                      onPress={async () => {
                        await Clipboard.setStringAsync(sheet.accessCode);
                        Alert.alert('Copied!', `Access code ${sheet.accessCode} copied to clipboard.`);
                      }}
                      activeOpacity={0.7}
                    >
                      <Copy size={16} color={Colors.primary} />
                    </TouchableOpacity>
                  </View>
                </View>

                <View style={styles.sheetPermissionsSection}>
                  <Text style={styles.sheetPermissionsTitle}>Permissions</Text>
                  
                  <View style={styles.permissionRow}>
                    <View style={styles.permissionInfo}>
                      {sheet.isLocked ? (
                        <LockKeyhole size={18} color={Colors.warning} />
                      ) : (
                        <UnlockKeyhole size={18} color={Colors.success} />
                      )}
                      <View style={styles.permissionTextContainer}>
                        <Text style={styles.permissionLabel}>
                          {sheet.isLocked ? 'Sheet Locked' : 'Sheet Unlocked'}
                        </Text>
                        <Text style={styles.permissionHint}>
                          {sheet.isLocked 
                            ? 'Users cannot re-import from this sheet' 
                            : 'Users with code can re-import data'}
                        </Text>
                      </View>
                    </View>
                    <TouchableOpacity
                      style={[
                        styles.permissionToggle,
                        sheet.isLocked && styles.permissionToggleActive
                      ]}
                      onPress={() => toggleSheetLock(sheet.id)}
                      activeOpacity={0.7}
                    >
                      <Text style={[
                        styles.permissionToggleText,
                        sheet.isLocked && styles.permissionToggleTextActive
                      ]}>
                        {sheet.isLocked ? 'Unlock' : 'Lock'}
                      </Text>
                    </TouchableOpacity>
                  </View>

                  <View style={styles.permissionRow}>
                    <View style={styles.permissionInfo}>
                      {sheet.allowEditing ? (
                        <Edit3 size={18} color={Colors.success} />
                      ) : (
                        <Eye size={18} color={Colors.textSecondary} />
                      )}
                      <View style={styles.permissionTextContainer}>
                        <Text style={styles.permissionLabel}>
                          {sheet.allowEditing ? 'Editing Allowed' : 'View Only'}
                        </Text>
                        <Text style={styles.permissionHint}>
                          {sheet.allowEditing 
                            ? 'Users with code can make edits' 
                            : 'Users can only view, not edit'}
                        </Text>
                      </View>
                    </View>
                    <TouchableOpacity
                      style={[
                        styles.permissionToggle,
                        sheet.allowEditing && styles.permissionToggleActive
                      ]}
                      onPress={() => toggleSheetEditing(sheet.id)}
                      activeOpacity={0.7}
                    >
                      <Text style={[
                        styles.permissionToggleText,
                        sheet.allowEditing && styles.permissionToggleTextActive
                      ]}>
                        {sheet.allowEditing ? 'Disable' : 'Allow'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>

                <View style={styles.sheetActionsRow}>
                  <TouchableOpacity
                    style={styles.sheetActionButton}
                    onPress={() => {
                      setShowImportedSheetsModal(false);
                      setSheetUrl(sheet.url);
                      setShowConnectModal(true);
                    }}
                    activeOpacity={0.7}
                  >
                    <RefreshCw size={16} color={Colors.primary} />
                    <Text style={styles.sheetActionButtonText}>Re-import</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.sheetActionButton, styles.sheetActionButtonDanger]}
                    onPress={() => {
                      Alert.alert(
                        'Remove Sheet',
                        'This will remove the sheet from your history. The access code will no longer work. Continue?',
                        [
                          { text: 'Cancel', style: 'cancel' },
                          {
                            text: 'Remove',
                            style: 'destructive',
                            onPress: () => deleteImportedSheet(sheet.id),
                          },
                        ]
                      );
                    }}
                    activeOpacity={0.7}
                  >
                    <Trash2 size={16} color={Colors.error} />
                    <Text style={[styles.sheetActionButtonText, styles.sheetActionButtonTextDanger]}>Remove</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </ScrollView>
        </View>
      </Modal>

      <Modal
        visible={editingRulesGroup !== null}
        animationType="slide"
        transparent
        onRequestClose={() => {
          setEditingRulesGroup(null);
          setRuleUrlInput('');
          setRuleUrlError(null);
        }}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {editingRulesGroup ? `${editingRulesGroup} Rules Link` : 'Rules Link'}
              </Text>
              <TouchableOpacity
                onPress={() => {
                  setEditingRulesGroup(null);
                  setRuleUrlInput('');
                  setRuleUrlError(null);
                }}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <X size={24} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <Text style={styles.ruleModalHint}>
              Paste a public URL to the rulebook (a website page or a Google Drive PDF share link). Leave empty to remove.
            </Text>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>URL</Text>
              <TextInput
                style={styles.ruleUrlInput}
                placeholder="https://..."
                placeholderTextColor={Colors.textMuted}
                value={ruleUrlInput}
                onChangeText={(t) => {
                  setRuleUrlInput(t);
                  if (ruleUrlError) setRuleUrlError(null);
                }}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                multiline
                testID="rules-url-input"
              />
            </View>

            {ruleUrlError && (
              <View style={styles.errorContainer}>
                <XCircle size={18} color={Colors.error} />
                <Text style={styles.errorText}>{ruleUrlError}</Text>
              </View>
            )}

            <View style={styles.ruleModalActions}>
              {editingRulesGroup && ruleLinks[editingRulesGroup] && (
                <TouchableOpacity
                  style={[styles.sheetActionButton, styles.sheetActionButtonDanger]}
                  onPress={async () => {
                    if (!editingRulesGroup) return;
                    await removeRuleLink(editingRulesGroup);
                    setEditingRulesGroup(null);
                    setRuleUrlInput('');
                  }}
                  activeOpacity={0.7}
                  testID="rules-remove"
                >
                  <Trash2 size={16} color={Colors.error} />
                  <Text style={[styles.sheetActionButtonText, styles.sheetActionButtonTextDanger]}>Remove</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[styles.sheetsPrimaryButton, { flex: 1 }, isSavingRuleLink && styles.sheetsPrimaryButtonDisabled]}
                onPress={handleSaveRuleLink}
                disabled={isSavingRuleLink}
                activeOpacity={0.7}
                testID="rules-save"
              >
                {isSavingRuleLink ? (
                  <ActivityIndicator size="small" color={Colors.white} />
                ) : (
                  <Text style={styles.sheetsPrimaryButtonText}>Save</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  content: {
    padding: 20,
    paddingBottom: 40,
  },
  header: {
    marginBottom: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: '700' as const,
    color: Colors.text,
  },
  subtitle: {
    fontSize: 15,
    color: Colors.textSecondary,
    marginTop: 4,
  },
  section: {
    marginBottom: 28,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600' as const,
    color: Colors.textSecondary,
    marginBottom: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  iconBg: {
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  cardContent: {
    flex: 1,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: Colors.text,
    marginBottom: 2,
  },
  cardDescription: {
    fontSize: 13,
    color: Colors.textSecondary,
  },
  connectedCard: {
    backgroundColor: '#E8F5E9',
    borderRadius: 14,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#A5D6A7',
  },
  connectedCardError: {
    backgroundColor: Colors.warningLight,
    borderColor: Colors.warning,
  },
  connectedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  connectedTitle: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: '#2E7D32',
    marginLeft: 10,
  },
  connectedTitleError: {
    color: Colors.warning,
  },
  errorBanner: {
    backgroundColor: 'rgba(255, 152, 0, 0.15)',
    padding: 10,
    borderRadius: 8,
    marginBottom: 8,
  },
  errorBannerText: {
    fontSize: 12,
    color: Colors.warning,
  },
  syncTime: {
    fontSize: 12,
    color: '#558B2F',
    marginTop: 4,
    fontStyle: 'italic' as const,
  },
  connectedDetail: {
    fontSize: 13,
    color: '#558B2F',
    marginBottom: 4,
  },
  connectedActions: {
    flexDirection: 'row',
    marginTop: 12,
    gap: 10,
  },
  refreshButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 6,
  },
  refreshButtonDisabled: {
    opacity: 0.7,
  },
  refreshButtonText: {
    fontSize: 14,
    fontWeight: '500' as const,
    color: Colors.primary,
  },
  disconnectButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 6,
  },
  disconnectButtonText: {
    fontSize: 14,
    fontWeight: '500' as const,
    color: Colors.error,
  },
  statusCard: {
    backgroundColor: Colors.surfaceAlt,
    borderRadius: 12,
    padding: 16,
    marginTop: 4,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  statusLabel: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginLeft: 8,
  },
  statusValue: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: Colors.text,
    marginBottom: 4,
  },
  statusNote: {
    fontSize: 13,
    color: Colors.textMuted,
  },
  infoCard: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  pinModeRow: {
    flexDirection: 'row',
    backgroundColor: Colors.surface,
    borderRadius: 12,
    padding: 4,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 4,
  },
  pinModeButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinModeButtonActive: {
    backgroundColor: Colors.primary,
  },
  pinModeButtonText: {
    fontSize: 14,
    fontWeight: '600' as const,
    color: Colors.textSecondary,
  },
  pinModeButtonTextActive: {
    color: Colors.white,
  },
  infoRow: {
    flexDirection: 'row',
  },
  infoContent: {
    flex: 1,
    marginLeft: 12,
  },
  infoTitle: {
    fontSize: 15,
    fontWeight: '600' as const,
    color: Colors.text,
    marginBottom: 4,
  },
  infoText: {
    fontSize: 13,
    color: Colors.textSecondary,
    lineHeight: 20,
  },
  footer: {
    alignItems: 'center',
    paddingTop: 20,
  },
  footerText: {
    fontSize: 13,
    color: Colors.textMuted,
    textAlign: 'center',
    lineHeight: 20,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: 40,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 24,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700' as const,
    color: Colors.text,
  },
  inputGroup: {
    marginBottom: 20,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '600' as const,
    color: Colors.text,
    marginBottom: 8,
  },
  input: {
    backgroundColor: Colors.background,
    borderRadius: 12,
    padding: 14,
    fontSize: 15,
    color: Colors.text,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  errorContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.errorLight,
    padding: 12,
    borderRadius: 10,
    marginBottom: 16,
    gap: 8,
  },
  errorText: {
    fontSize: 14,
    color: Colors.error,
    flex: 1,
  },
  connectButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primary,
    borderRadius: 12,
    padding: 16,
    gap: 8,
  },
  dangerButton: {
    backgroundColor: Colors.error,
  },
  connectButtonText: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: Colors.white,
  },
  modalInfo: {
    marginTop: 16,
    padding: 12,
    backgroundColor: Colors.surfaceAlt,
    borderRadius: 10,
  },
  modalInfoText: {
    fontSize: 12,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  adminCard: {
    backgroundColor: Colors.primaryLight,
    borderRadius: 14,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: Colors.primary,
  },
  editorCard: {
    backgroundColor: '#E3F2FD',
    borderColor: '#2196F3',
  },
  adminHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  adminTitle: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: Colors.primary,
    marginLeft: 10,
  },
  editorTitle: {
    color: '#1976D2',
  },
  adminDetail: {
    fontSize: 13,
    color: Colors.text,
    marginBottom: 4,
    lineHeight: 20,
  },
  adminActions: {
    flexDirection: 'row',
    marginTop: 12,
    gap: 10,
    flexWrap: 'wrap',
  },
  changePinButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 6,
  },
  changePinButtonText: {
    fontSize: 14,
    fontWeight: '500' as const,
    color: Colors.primary,
  },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 6,
  },
  logoutButtonText: {
    fontSize: 14,
    fontWeight: '500' as const,
    color: Colors.warning,
  },
  viewerCard: {
    backgroundColor: Colors.surfaceAlt,
    borderRadius: 14,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  viewerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  viewerTitle: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: Colors.textSecondary,
    marginLeft: 10,
  },
  viewerDetail: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginBottom: 4,
    lineHeight: 20,
  },
  unlockButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primary,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 10,
    marginTop: 12,
    gap: 8,
  },
  unlockButtonText: {
    fontSize: 15,
    fontWeight: '600' as const,
    color: Colors.white,
  },
  pinInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.background,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  pinInput: {
    flex: 1,
    padding: 14,
    fontSize: 15,
    color: Colors.text,
  },
  eyeButton: {
    padding: 14,
  },
  editorManagementCard: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  editorStatusRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  editorStatusContent: {
    flex: 1,
    marginLeft: 12,
  },
  editorStatusTitle: {
    fontSize: 15,
    fontWeight: '600' as const,
    color: Colors.text,
    marginBottom: 4,
  },
  editorStatusSubtitle: {
    fontSize: 13,
    color: Colors.textSecondary,
    lineHeight: 18,
  },
  editorActions: {
    flexDirection: 'row',
    marginTop: 16,
    gap: 10,
    flexWrap: 'wrap',
  },
  editorActionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.primaryLight,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    gap: 6,
  },
  editorActionDanger: {
    backgroundColor: Colors.errorLight,
  },
  editorActionText: {
    fontSize: 14,
    fontWeight: '500' as const,
    color: Colors.primary,
  },
  editorActionTextDanger: {
    color: Colors.error,
  },
  inputHelper: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: 6,
    lineHeight: 16,
  },
  activeEditorsCard: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  activeEditorsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  activeEditorsTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  activeEditorsTitle: {
    fontSize: 15,
    fontWeight: '600' as const,
    color: Colors.text,
  },
  activeEditorsCountPill: {
    backgroundColor: Colors.primaryLight,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    minWidth: 22,
    alignItems: 'center',
  },
  activeEditorsCountText: {
    fontSize: 12,
    fontWeight: '700' as const,
    color: Colors.primary,
  },
  activeEditorsEmpty: {
    paddingVertical: 14,
    alignItems: 'center',
    gap: 8,
  },
  activeEditorsEmptyText: {
    fontSize: 13,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 18,
  },
  activeEditorsErrorText: {
    fontSize: 13,
    color: Colors.error,
    textAlign: 'center',
    lineHeight: 18,
  },
  activeEditorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    gap: 12,
  },
  activeEditorAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activeEditorAvatarText: {
    fontSize: 15,
    fontWeight: '700' as const,
    color: Colors.primary,
  },
  activeEditorInfo: {
    flex: 1,
    minWidth: 0,
  },
  activeEditorName: {
    fontSize: 14,
    fontWeight: '600' as const,
    color: Colors.text,
  },
  activeEditorMeta: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  activeEditorRevoke: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: Colors.errorLight,
  },
  activeEditorRevokeText: {
    fontSize: 12,
    fontWeight: '600' as const,
    color: Colors.error,
  },
  sheetsModalContainer: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  sheetsModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  sheetsModalHeaderTitle: {
    fontSize: 18,
    fontWeight: '600' as const,
    color: Colors.text,
  },
  sheetsCloseButton: {
    padding: 4,
  },
  sheetsBackButton: {
    padding: 4,
    marginRight: 8,
  },
  sheetsHeaderSpacer: {
    width: 32,
  },
  sheetsStepContainer: {
    flex: 1,
    padding: 20,
  },
  sheetsUploadIcon: {
    alignSelf: 'center',
    width: 100,
    height: 100,
    borderRadius: 50,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
    marginTop: 40,
  },
  sheetsSuccessIcon: {
    alignSelf: 'center',
    marginBottom: 24,
    marginTop: 40,
  },
  sheetsStepTitle: {
    fontSize: 24,
    fontWeight: '700' as const,
    color: Colors.text,
    textAlign: 'center',
    marginBottom: 8,
  },
  sheetsStepDescription: {
    fontSize: 15,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginBottom: 24,
  },
  sheetsInputContainer: {
    width: '100%',
    marginBottom: 16,
  },
  sheetsInputLabel: {
    fontSize: 14,
    fontWeight: '500' as const,
    color: Colors.text,
    marginBottom: 8,
  },
  sheetsUrlInput: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: Colors.text,
  },
  sheetsFormatInfo: {
    backgroundColor: Colors.surfaceAlt,
    padding: 16,
    borderRadius: 12,
    marginBottom: 24,
  },
  sheetsFormatTitle: {
    fontSize: 14,
    fontWeight: '600' as const,
    color: Colors.text,
    marginBottom: 8,
  },
  sheetsFormatText: {
    fontSize: 13,
    color: Colors.textSecondary,
    lineHeight: 20,
  },
  sheetsPrimaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 24,
    gap: 8,
  },
  sheetsPrimaryButtonText: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: Colors.white,
  },
  sheetsPrimaryButtonDisabled: {
    backgroundColor: Colors.textMuted,
  },
  sheetsSecondaryButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
    borderRadius: 12,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    marginRight: 12,
  },
  sheetsSecondaryButtonText: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: Colors.textSecondary,
  },
  sheetsButtonRow: {
    flexDirection: 'row',
    marginTop: 16,
  },
  sheetsMappingList: {
    flex: 1,
  },
  sheetsMappingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  sheetsMappingField: {
    width: 100,
  },
  sheetsMappingFieldLabel: {
    fontSize: 14,
    fontWeight: '500' as const,
    color: Colors.text,
  },
  sheetsRequiredStar: {
    color: Colors.error,
  },
  sheetsMappingOptions: {
    flex: 1,
    marginLeft: 12,
  },
  sheetsMappingOption: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: Colors.surfaceAlt,
    marginRight: 8,
  },
  sheetsMappingOptionSelected: {
    backgroundColor: Colors.primary,
  },
  sheetsMappingOptionText: {
    fontSize: 13,
    color: Colors.textSecondary,
  },
  sheetsMappingOptionTextSelected: {
    color: Colors.white,
    fontWeight: '500' as const,
  },
  sheetsPreviewList: {
    flex: 1,
    marginBottom: 16,
  },
  sheetsPreviewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  sheetsPreviewIndex: {
    width: 32,
    fontSize: 13,
    color: Colors.textMuted,
  },
  sheetsPreviewInfo: {
    flex: 1,
  },
  sheetsPreviewName: {
    fontSize: 15,
    fontWeight: '500' as const,
    color: Colors.text,
    marginBottom: 2,
  },
  sheetsPreviewMeta: {
    fontSize: 13,
    color: Colors.textSecondary,
  },
  sheetsPreviewMore: {
    fontSize: 14,
    color: Colors.textMuted,
    textAlign: 'center',
    paddingVertical: 16,
  },
  orgCard: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  orgHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  orgInfo: {
    marginLeft: 12,
    flex: 1,
  },
  orgName: {
    fontSize: 18,
    fontWeight: '600' as const,
    color: Colors.text,
  },
  orgRole: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  orgCodeSection: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  orgCodeLabel: {
    fontSize: 12,
    fontWeight: '600' as const,
    color: Colors.textSecondary,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  orgCodeRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  orgCode: {
    fontSize: 28,
    fontWeight: '700' as const,
    color: Colors.primary,
    letterSpacing: 4,
    flex: 1,
  },
  copyButton: {
    padding: 10,
    backgroundColor: Colors.primaryLight,
    borderRadius: 8,
    marginLeft: 8,
  },
  shareButton: {
    padding: 10,
    backgroundColor: Colors.primaryLight,
    borderRadius: 8,
    marginLeft: 8,
  },
  orgCodeHint: {
    fontSize: 12,
    color: Colors.textMuted,
    marginTop: 8,
    lineHeight: 16,
  },
  switchOrgButton: {
    marginTop: 12,
    paddingVertical: 10,
    alignItems: 'center',
  },
  switchOrgText: {
    fontSize: 14,
    color: Colors.primary,
    fontWeight: '500' as const,
  },
  noOrgCard: {
    backgroundColor: Colors.surfaceAlt,
    borderRadius: 14,
    padding: 24,
    alignItems: 'center',
    marginBottom: 10,
  },
  noOrgTitle: {
    fontSize: 18,
    fontWeight: '600' as const,
    color: Colors.text,
    marginTop: 12,
    marginBottom: 4,
  },
  noOrgText: {
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginBottom: 20,
  },
  orgActions: {
    flexDirection: 'row',
    gap: 12,
  },
  joinOrgButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.primary,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 10,
    gap: 8,
  },
  joinOrgButtonText: {
    fontSize: 15,
    fontWeight: '600' as const,
    color: Colors.white,
  },
  createOrgButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.primary,
    gap: 8,
  },
  createOrgButtonText: {
    fontSize: 15,
    fontWeight: '600' as const,
    color: Colors.primary,
  },
  codeInput: {
    fontSize: 24,
    fontWeight: '600' as const,
    letterSpacing: 8,
    textAlign: 'center',
  },
  privacyModalContainer: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  privacyModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  privacyModalTitle: {
    fontSize: 18,
    fontWeight: '600' as const,
    color: Colors.text,
  },
  privacyCloseButton: {
    padding: 4,
  },
  privacyContent: {
    flex: 1,
    padding: 20,
  },
  privacyLastUpdated: {
    fontSize: 13,
    color: Colors.textMuted,
    marginBottom: 20,
    fontStyle: 'italic' as const,
  },
  privacySection: {
    fontSize: 17,
    fontWeight: '700' as const,
    color: Colors.text,
    marginTop: 24,
    marginBottom: 12,
  },
  privacySubsection: {
    fontSize: 15,
    fontWeight: '600' as const,
    color: Colors.text,
    marginTop: 16,
    marginBottom: 8,
  },
  privacyText: {
    fontSize: 14,
    color: Colors.textSecondary,
    lineHeight: 22,
    marginBottom: 12,
  },
  privacyFooter: {
    marginTop: 32,
    marginBottom: 40,
    paddingTop: 20,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  privacyFooterText: {
    fontSize: 13,
    color: Colors.textMuted,
    textAlign: 'center',
    fontStyle: 'italic' as const,
    lineHeight: 20,
  },
  savedSheetCard: {
    backgroundColor: '#E8F5E9',
    borderRadius: 14,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#A5D6A7',
  },
  savedSheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  savedSheetInfo: {
    marginLeft: 10,
    flex: 1,
  },
  savedSheetTitle: {
    fontSize: 15,
    fontWeight: '600' as const,
    color: '#2E7D32',
  },
  savedSheetDetail: {
    fontSize: 12,
    color: '#558B2F',
    marginTop: 2,
  },
  savedSheetId: {
    fontSize: 12,
    color: '#558B2F',
    marginBottom: 12,
  },
  savedSheetActions: {
    flexDirection: 'row',
    gap: 10,
  },
  reImportButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#34A853',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    gap: 6,
  },
  reImportButtonText: {
    fontSize: 14,
    fontWeight: '600' as const,
    color: Colors.white,
  },
  enableWriteBackButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.white,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#34A853',
    gap: 6,
  },
  enableWriteBackText: {
    fontSize: 14,
    fontWeight: '600' as const,
    color: '#34A853',
  },
  importedSheetsContent: {
    flex: 1,
    padding: 20,
  },
  importedSheetsDescription: {
    fontSize: 14,
    color: Colors.textSecondary,
    lineHeight: 20,
    marginBottom: 20,
  },
  importedSheetCard: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  importedSheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  importedSheetInfo: {
    marginLeft: 12,
    flex: 1,
  },
  importedSheetTitle: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: Colors.text,
  },
  importedSheetMeta: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  accessCodeSection: {
    backgroundColor: '#E8F5E9',
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
  },
  accessCodeLabel: {
    fontSize: 11,
    fontWeight: '600' as const,
    color: '#558B2F',
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  accessCodeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  accessCodeValue: {
    fontSize: 24,
    fontWeight: '700' as const,
    color: '#2E7D32',
    letterSpacing: 4,
  },
  accessCodeCopyButton: {
    padding: 8,
    backgroundColor: Colors.white,
    borderRadius: 8,
  },
  sheetPermissionsSection: {
    marginBottom: 16,
  },
  sheetPermissionsTitle: {
    fontSize: 13,
    fontWeight: '600' as const,
    color: Colors.textSecondary,
    marginBottom: 12,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
  },
  permissionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  permissionInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  permissionTextContainer: {
    marginLeft: 10,
    flex: 1,
  },
  permissionLabel: {
    fontSize: 14,
    fontWeight: '500' as const,
    color: Colors.text,
  },
  permissionHint: {
    fontSize: 12,
    color: Colors.textMuted,
    marginTop: 2,
  },
  permissionToggle: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: Colors.surfaceAlt,
  },
  permissionToggleActive: {
    backgroundColor: Colors.primaryLight,
  },
  permissionToggleText: {
    fontSize: 13,
    fontWeight: '500' as const,
    color: Colors.textSecondary,
  },
  permissionToggleTextActive: {
    color: Colors.primary,
  },
  sheetActionsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  sheetActionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primaryLight,
    paddingVertical: 10,
    borderRadius: 8,
    gap: 6,
  },
  sheetActionButtonDanger: {
    backgroundColor: Colors.errorLight,
  },
  sheetActionButtonText: {
    fontSize: 14,
    fontWeight: '500' as const,
    color: Colors.primary,
  },
  sheetActionButtonTextDanger: {
    color: Colors.error,
  },
  rulesCard: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  rulesHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  rulesIconContainer: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#FEF3C7',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  rulesHeaderTitle: {
    fontSize: 17,
    fontWeight: '700' as const,
    color: Colors.text,
  },
  rulesHeaderSubtitle: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  weightTable: {
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 16,
  },
  weightTableHeader: {
    flexDirection: 'row',
    backgroundColor: '#1F2937',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  weightTableHeaderText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600' as const,
    color: '#F9FAFB',
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
  },
  weightTableRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: Colors.surface,
  },
  weightTableRowAlt: {
    backgroundColor: Colors.background,
  },
  weightTableGroup: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600' as const,
    color: Colors.text,
  },
  weightTableLimit: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500' as const,
    color: '#D97706',
  },
  rulesDivider: {
    height: 1,
    backgroundColor: Colors.border,
    marginBottom: 16,
  },
  rulesOptionsSection: {
    marginBottom: 16,
  },
  rulesOptionsTitle: {
    fontSize: 13,
    fontWeight: '600' as const,
    color: Colors.textSecondary,
    marginBottom: 12,
    lineHeight: 18,
  },
  rulesOptionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  rulesOptionIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  rulesOptionLabel: {
    fontSize: 14,
    fontWeight: '600' as const,
    color: Colors.text,
  },
  rulesOptionDesc: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: 1,
  },
  rulesNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#FFFBEB',
    borderRadius: 8,
    padding: 10,
    gap: 8,
  },
  rulesNoteText: {
    flex: 1,
    fontSize: 12,
    color: '#92400E',
    lineHeight: 17,
  },
  ruleLinksCard: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  ruleLinksHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  ruleLinksTitle: {
    fontSize: 17,
    fontWeight: '700' as const,
    color: Colors.text,
  },
  ruleLinksSubtitle: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginTop: 2,
    lineHeight: 18,
  },
  ruleLinksList: {
    gap: 8,
  },
  ruleLinkRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 8,
  },
  ruleLinkMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surfaceAlt,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    gap: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  ruleLinkMainEmpty: {
    backgroundColor: Colors.background,
    borderStyle: 'dashed' as const,
  },
  ruleLinkBadge: {
    minWidth: 44,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#DBEAFE',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ruleLinkBadgeText: {
    fontSize: 13,
    fontWeight: '700' as const,
    color: '#1D4ED8',
    letterSpacing: 0.5,
  },
  ruleLinkTitle: {
    fontSize: 14,
    fontWeight: '600' as const,
    color: Colors.text,
  },
  ruleLinkUrl: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  ruleLinkEmpty: {
    fontSize: 12,
    color: Colors.textMuted,
    marginTop: 2,
    fontStyle: 'italic' as const,
  },
  ruleLinkEditButton: {
    width: 40,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primaryLight,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  ruleLinksTip: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginTop: 14,
    padding: 10,
    borderRadius: 8,
    backgroundColor: Colors.surfaceAlt,
  },
  ruleLinksTipText: {
    flex: 1,
    fontSize: 12,
    color: Colors.textSecondary,
    lineHeight: 17,
  },
  ruleModalHint: {
    fontSize: 13,
    color: Colors.textSecondary,
    lineHeight: 18,
    marginBottom: 12,
  },
  ruleUrlInput: {
    backgroundColor: Colors.surfaceAlt,
    borderRadius: 10,
    padding: 12,
    fontSize: 14,
    color: Colors.text,
    borderWidth: 1,
    borderColor: Colors.border,
    minHeight: 60,
  },
  ruleModalActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 8,
  },
  pendingSyncRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    gap: 8,
  },
  pendingSyncText: {
    flex: 1,
    fontSize: 13,
    color: '#F59E0B',
    fontWeight: '500' as const,
  },
  retrySyncButton: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    backgroundColor: '#FEF3C7',
    borderRadius: 6,
  },
  retrySyncText: {
    fontSize: 12,
    fontWeight: '600' as const,
    color: '#D97706',
  },
  syncErrorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    gap: 6,
  },
  syncErrorText: {
    flex: 1,
    fontSize: 12,
    color: Colors.error,
  },
  eventModeCard: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  eventModeHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 14,
  },
  eventModeIcon: {
    width: 42,
    height: 42,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eventModeTitle: {
    fontSize: 16,
    fontWeight: '700' as const,
    color: Colors.text,
    marginBottom: 4,
  },
  eventModeSubtitle: {
    fontSize: 13,
    color: Colors.textSecondary,
    lineHeight: 18,
  },
  eventModeToggleRow: {
    flexDirection: 'row',
    backgroundColor: Colors.surfaceAlt,
    borderRadius: 10,
    padding: 4,
    gap: 4,
  },
  eventModeButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: 8,
    gap: 6,
  },
  eventModeButtonActive: {
    backgroundColor: '#16A34A',
  },
  eventModeButtonActiveView: {
    backgroundColor: '#D97706',
  },
  eventModeButtonText: {
    fontSize: 13,
    fontWeight: '600' as const,
    color: Colors.textSecondary,
  },
  eventModeButtonTextActive: {
    color: Colors.white,
  },
  modalOverlayDismiss: {
    flex: 1,
  },
  myOrgsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 10,
  },
  myOrgsButtonText: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500' as const,
    color: Colors.primary,
  },
  myOrgCard: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  myOrgCardActive: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryLight,
  },
  myOrgHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  myOrgIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  myOrgInfo: {
    flex: 1,
  },
  myOrgName: {
    fontSize: 17,
    fontWeight: '600' as const,
    color: Colors.text,
    marginBottom: 2,
  },
  myOrgMeta: {
    fontSize: 13,
    color: Colors.textSecondary,
  },
  orgBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
  },
  expiredBadge: {
    backgroundColor: Colors.errorLight,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  expiredBadgeText: {
    fontSize: 11,
    fontWeight: '600' as const,
    color: Colors.error,
  },
  expiringSoonBadge: {
    backgroundColor: '#FEF3C7',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  expiringSoonBadgeText: {
    fontSize: 11,
    fontWeight: '600' as const,
    color: '#D97706',
  },
  activeBadge: {
    backgroundColor: '#DCFCE7',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  activeBadgeText: {
    fontSize: 11,
    fontWeight: '600' as const,
    color: '#16A34A',
  },
  orgShareCodeCard: {
    backgroundColor: '#F0FDF4',
    borderRadius: 10,
    padding: 12,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#BBF7D0',
  },
  orgShareCodeHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  orgShareCodeLabel: {
    fontSize: 11,
    fontWeight: '700' as const,
    color: '#16A34A',
    letterSpacing: 1,
  },
  orgExpiryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  orgExpiryText: {
    fontSize: 11,
    color: Colors.textMuted,
  },
  orgExpiryTextWarning: {
    color: '#D97706',
    fontWeight: '500' as const,
  },
  orgShareCodeValueRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  orgShareCodeValue: {
    fontSize: 26,
    fontWeight: '800' as const,
    color: '#15803D',
    letterSpacing: 5,
    flex: 1,
  },
  orgShareCodeValueExpired: {
    color: Colors.textMuted,
    textDecorationLine: 'line-through' as const,
  },
  orgShareCopyBtn: {
    padding: 8,
    backgroundColor: '#DCFCE7',
    borderRadius: 8,
    marginLeft: 6,
  },
  orgShareShareBtn: {
    padding: 8,
    backgroundColor: '#DCFCE7',
    borderRadius: 8,
    marginLeft: 6,
  },
  orgShareCodeHint: {
    fontSize: 11,
    color: '#4ADE80',
    marginTop: 6,
  },
  syncAllBanner: {
    backgroundColor: '#F0FDF4',
    borderWidth: 1,
    borderColor: '#86EFAC',
    borderRadius: 12,
    padding: 14,
    marginBottom: 14,
    gap: 8,
  },
  syncAllBannerHeader: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8,
  },
  syncAllBannerTitle: {
    fontSize: 14,
    fontWeight: '700' as const,
    color: Colors.text,
  },
  syncAllBannerText: {
    fontSize: 12,
    color: Colors.textSecondary,
    lineHeight: 17,
  },
  syncAllBannerButton: {
    marginTop: 4,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: 8,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: Colors.primary,
  },
  syncAllBannerButtonDisabled: {
    opacity: 0.6,
  },
  syncAllBannerButtonText: {
    color: Colors.white,
    fontSize: 14,
    fontWeight: '700' as const,
  },
  orgSyncCloudBtn: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: '#DCFCE7',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#86EFAC',
  },
  orgSyncCloudBtnText: {
    fontSize: 12,
    fontWeight: '600' as const,
    color: Colors.primary,
  },
  currentBadge: {
    backgroundColor: Colors.primary,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    alignSelf: 'flex-start',
    marginTop: 6,
  },
  currentBadgeText: {
    fontSize: 11,
    fontWeight: '600' as const,
    color: Colors.white,
  },
  myOrgActions: {
    flexDirection: 'row',
    gap: 10,
    flexWrap: 'wrap',
  },
  myOrgActionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.primaryLight,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 6,
  },
  myOrgActionText: {
    fontSize: 13,
    fontWeight: '500' as const,
    color: Colors.primary,
  },
  myOrgCopyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surfaceAlt,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 6,
  },
  myOrgDeleteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.errorLight,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 6,
  },
  myOrgDeleteText: {
    fontSize: 13,
    fontWeight: '500' as const,
    color: Colors.error,
  },
  myOrgLeaveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.warningLight,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 6,
  },
  myOrgLeaveText: {
    fontSize: 13,
    fontWeight: '500' as const,
    color: Colors.warning,
  },
  toggleSwitch: {
    width: 48,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.border,
    padding: 2,
    justifyContent: 'center',
  },
  toggleSwitchOn: {
    backgroundColor: '#16A34A',
  },
  toggleKnob: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: Colors.white,
  },
  toggleKnobOn: {
    alignSelf: 'flex-end',
  },
  emptyOrgsContainer: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  emptyOrgsTitle: {
    fontSize: 18,
    fontWeight: '600' as const,
    color: Colors.text,
    marginTop: 12,
    marginBottom: 4,
  },
  emptyOrgsText: {
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
});
