import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Image,
  Alert,
  Modal,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft,
  Plus,
  User,
  Camera,
  ShieldCheck,
  Shield,
  Trash2,
  X,
  Check,
  Pencil,
  Upload,
} from 'lucide-react-native';
import * as ImagePicker from 'expo-image-picker';
import { useRegistration } from '@/contexts/RegistrationContext';
import { useAuth } from '@/contexts/AuthContext';
import CoachCSVImportModal, { type ParsedCoach } from '@/components/CoachCSVImportModal';
import FilterDropdown from '@/components/FilterDropdown';
import Colors from '@/constants/colors';
import type { Coach, CoachTeam, Player } from '@/types';
import { compareTeamByName } from '@/utils/teamAssignments';

type CoachAdminAPI = {
  coaches: Coach[];
  coachTeams: CoachTeam[];
  players: Player[];
  addCoach: (
    input: Omit<Coach, 'id' | 'checkedIn' | 'checkedInAt'>,
    teamAssignments: Omit<CoachTeam, 'id' | 'coachId' | 'orgId'>[],
  ) => Promise<Coach | null>;
  deleteCoach: (coachId: string) => Promise<void>;
  setCoachTeamAssignments: (
    coachId: string,
    teamAssignments: Omit<CoachTeam, 'id' | 'coachId' | 'orgId'>[],
  ) => Promise<void>;
  updateCoach: (coach: Coach) => Promise<void>;
};

type TeamAssignmentDraft = Omit<CoachTeam, 'id' | 'coachId' | 'orgId'>;

function teamKey(t: { club: string; ageGroup: string; division: string; teamName: string }): string {
  return `${t.club}|${t.ageGroup}|${t.division}|${t.teamName}`.toLowerCase();
}

export default function CoachAdminScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { isAdmin, canEdit } = useAuth();
  const {
    coaches,
    coachTeams,
    players,
    clubs: canonicalClubs,
    addCoach,
    deleteCoach,
    setCoachTeamAssignments,
    updateCoach,
    importCoaches,
  } = useRegistration() as unknown as CoachAdminAPI & {
    importCoaches: (rows: ParsedCoach[]) => Promise<{ created: number; skipped: number }>;
  };

  const [editingCoachId, setEditingCoachId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  // Form state
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [isCertified, setIsCertified] = useState(false);
  const [teamDrafts, setTeamDrafts] = useState<TeamAssignmentDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [coachClub, setCoachClub] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);

  // Available teams derived from players (the actual roster contexts)
  const availableTeams = useMemo<TeamAssignmentDraft[]>(() => {
    const map = new Map<string, TeamAssignmentDraft>();
    for (const p of players) {
      const name = (p.teamName || '').trim();
      if (!name) continue;
      const draft: TeamAssignmentDraft = {
        club: p.club || '',
        ageGroup: p.ageGroup || '',
        division: p.division || '',
        teamName: name,
      };
      const k = teamKey(draft);
      if (!map.has(k)) map.set(k, draft);
    }
    return Array.from(map.values()).sort(compareTeamByName);
  }, [players]);

  // Clubs derived from the actual player roster so they always match
  // the club names used in imported data (e.g. "Little Brighton", not "Brighton").
  // Falls back to the canonical club list when the roster is empty.
  const rosterClubs = useMemo<string[]>(() => {
    const set = new Set<string>();
    for (const t of availableTeams) {
      const club = (t.club || '').trim();
      if (club) set.add(club);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [availableTeams]);

  const clubDropdownOptions = useMemo<string[]>(() => {
    if (rosterClubs.length > 0) return rosterClubs;
    return (canonicalClubs as unknown as { name: string }[]).map((c) => c.name);
  }, [rosterClubs, canonicalClubs]);

  const filteredAvailableTeams = useMemo(() => {
    if (!coachClub) return availableTeams;
    const target = coachClub.toLowerCase();
    return availableTeams.filter((t) => (t.club || '').toLowerCase() === target);
  }, [availableTeams, coachClub]);

  const sortedCoaches = useMemo(
    () =>
      [...coaches].sort((a, b) =>
        `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`),
      ),
    [coaches],
  );

  const resetForm = useCallback(() => {
    setEditingCoachId(null);
    setShowAdd(false);
    setFirstName('');
    setLastName('');
    setPhotoUri(null);
    setIsCertified(false);
    setTeamDrafts([]);
    setCoachClub(null);
  }, []);

  const openAdd = useCallback(() => {
    resetForm();
    setShowAdd(true);
  }, [resetForm]);

  const openEdit = useCallback(
    (coach: Coach) => {
      setEditingCoachId(coach.id);
      setShowAdd(true);
      setFirstName(coach.firstName);
      setLastName(coach.lastName);
      setPhotoUri(coach.photoUri ?? null);
      setIsCertified(coach.isCertified);
      const assignments = coachTeams
        .filter((ct) => ct.coachId === coach.id)
        .map((ct) => ({
          club: ct.club,
          ageGroup: ct.ageGroup,
          division: ct.division,
          teamName: ct.teamName,
        }));
      setTeamDrafts(assignments);
      // Pre-select club from first assignment, auto-filter team picker
      const firstClub = assignments[0]?.club || null;
      setCoachClub(firstClub);
    },
    [coachTeams],
  );

  const handlePickPhoto = useCallback(async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Photo library access is needed.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.8,
      allowsEditing: true,
      aspect: [1, 1],
    });
    if (result.canceled || !result.assets?.[0]?.uri) return;
    setPhotoUri(result.assets[0].uri);
  }, []);

  const handleTakePhoto = useCallback(async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Camera access is needed.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      quality: 0.8,
      allowsEditing: true,
      aspect: [1, 1],
    });
    if (result.canceled || !result.assets?.[0]?.uri) return;
    setPhotoUri(result.assets[0].uri);
  }, []);

  const handlePhotoTap = useCallback(() => {
    Alert.alert('Coach Photo', undefined, [
      { text: 'Take Photo', onPress: () => void handleTakePhoto() },
      { text: 'Choose from Library', onPress: () => void handlePickPhoto() },
      ...(photoUri
        ? [
            {
              text: 'Remove',
              style: 'destructive' as const,
              onPress: () => setPhotoUri(null),
            },
          ]
        : []),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  }, [handleTakePhoto, handlePickPhoto, photoUri]);

  const toggleTeamDraft = useCallback((team: TeamAssignmentDraft) => {
    setTeamDrafts((prev) => {
      const k = teamKey(team);
      const existing = prev.find((t) => teamKey(t) === k);
      if (existing) return prev.filter((t) => teamKey(t) !== k);
      return [...prev, team];
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (!firstName.trim() || !lastName.trim()) {
      Alert.alert('Missing Info', 'Please enter both first and last name.');
      return;
    }
    if (!photoUri) {
      Alert.alert('Photo Required', 'Please add a photo of the coach before saving.');
      return;
    }
    setSaving(true);
    try {
      if (editingCoachId) {
        const existing = coaches.find((c) => c.id === editingCoachId);
        if (!existing) throw new Error('Coach not found');
        await updateCoach({
          ...existing,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          photoUri: photoUri ?? null,
          isCertified,
        });
        await setCoachTeamAssignments(editingCoachId, teamDrafts);
      } else {
        await addCoach(
          {
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            photoUri: photoUri ?? null,
            isCertified,
          },
          teamDrafts,
        );
      }
      resetForm();
    } catch (err) {
      Alert.alert('Error', (err as Error).message || 'Could not save coach.');
    } finally {
      setSaving(false);
    }
  }, [
    firstName,
    lastName,
    photoUri,
    isCertified,
    teamDrafts,
    editingCoachId,
    coaches,
    addCoach,
    updateCoach,
    setCoachTeamAssignments,
    resetForm,
  ]);

  const handleDelete = useCallback(
    (coach: Coach) => {
      Alert.alert(
        'Delete Coach',
        `Remove ${coach.firstName} ${coach.lastName}? This also removes their team assignments. This cannot be undone.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: async () => {
              try {
                await deleteCoach(coach.id);
              } catch (err) {
                Alert.alert('Error', (err as Error).message || 'Failed to delete.');
              }
            },
          },
        ],
      );
    },
    [deleteCoach],
  );

  if (!canEdit) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <ArrowLeft size={24} color={Colors.white} />
          </TouchableOpacity>
          <Text style={styles.title}>Manage Coaches</Text>
        </View>
        <View style={styles.emptyContainer}>
          <Shield size={48} color={Colors.textMuted} />
          <Text style={styles.emptyText}>Edit access required to manage coaches.</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <ArrowLeft size={24} color={Colors.white} />
        </TouchableOpacity>
        <Text style={styles.title}>Manage Coaches</Text>
        <TouchableOpacity onPress={openAdd} style={styles.addBtn}>
          <Plus size={22} color={Colors.white} />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setShowImport(true)} style={styles.importBtn}>
          <Upload size={20} color={Colors.white} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {sortedCoaches.length === 0 ? (
          <View style={styles.emptyState}>
            <User size={40} color={Colors.textMuted} />
            <Text style={styles.emptyStateTitle}>No coaches yet</Text>
            <Text style={styles.emptyStateSub}>
              Tap the + button to add your first coach and assign them to teams.
            </Text>
          </View>
        ) : (
          sortedCoaches.map((coach) => {
            const assignments = coachTeams.filter((ct) => ct.coachId === coach.id);
            return (
              <View key={coach.id} style={styles.row}>
                <View style={styles.photoWrap}>
                  {coach.photoUri ? (
                    <Image source={{ uri: coach.photoUri }} style={styles.photo} />
                  ) : (
                    <View style={styles.photoPlaceholder}>
                      <User size={22} color={Colors.textMuted} />
                    </View>
                  )}
                </View>
                <View style={styles.rowInfo}>
                  <Text style={styles.rowName}>
                    {coach.lastName}, {coach.firstName}
                  </Text>
                  <View style={styles.rowMetaRow}>
                    {coach.isCertified ? (
                      <ShieldCheck size={13} color={Colors.success} />
                    ) : (
                      <Shield size={13} color={Colors.warning} />
                    )}
                    <Text style={[styles.rowMeta, { color: coach.isCertified ? Colors.success : Colors.warning }]}>
                      {coach.isCertified ? 'Certified' : 'Not Certified'}
                    </Text>
                    <Text style={styles.rowMetaDim}>
                      • {assignments.length} team{assignments.length === 1 ? '' : 's'}
                    </Text>
                  </View>
                  {assignments.length > 0 && (
                    <Text style={styles.rowTeams} numberOfLines={2}>
                      {assignments
                        .map((a) => a.teamName || `${a.club} ${a.ageGroup}`)
                        .join(', ')}
                    </Text>
                  )}
                </View>
                <View style={styles.rowActions}>
                  <TouchableOpacity onPress={() => openEdit(coach)} style={styles.iconBtn}>
                    <Pencil size={18} color={Colors.primary} />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => handleDelete(coach)} style={styles.iconBtn}>
                    <Trash2 size={18} color={Colors.danger ?? '#dc2626'} />
                  </TouchableOpacity>
                </View>
              </View>
            );
          })
        )}
      </ScrollView>

      {/* Add / Edit modal */}
      <Modal visible={showAdd} animationType="slide" transparent={false} onRequestClose={resetForm}>
        <KeyboardAvoidingView
          style={{ flex: 1, backgroundColor: Colors.background }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
            <TouchableOpacity onPress={resetForm} style={styles.backBtn}>
              <X size={24} color={Colors.white} />
            </TouchableOpacity>
            <Text style={styles.title}>{editingCoachId ? 'Edit Coach' : 'Add Coach'}</Text>
            <TouchableOpacity
              onPress={handleSave}
              style={styles.addBtn}
              disabled={saving}
            >
              {saving ? (
                <ActivityIndicator color={Colors.white} />
              ) : (
                <Check size={22} color={Colors.white} />
              )}
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            {/* Photo */}
            <View style={styles.photoSection}>
              <TouchableOpacity
                style={styles.bigPhotoWrap}
                onPress={handlePhotoTap}
                activeOpacity={0.7}
              >
                {photoUri ? (
                  <Image source={{ uri: photoUri }} style={styles.bigPhoto} />
                ) : (
                  <View style={styles.bigPhotoPlaceholder}>
                    <User size={48} color={Colors.textMuted} />
                  </View>
                )}
                <View style={styles.cameraBadge}>
                  <Camera size={14} color={Colors.white} />
                </View>
              </TouchableOpacity>
              <Text style={styles.photoHint}>
                Tap to set photo <Text style={styles.requiredStar}>*</Text>
              </Text>
            </View>

            {/* Name */}
            <View style={styles.formSection}>
              <Text style={styles.label}>First Name</Text>
              <TextInput
                value={firstName}
                onChangeText={setFirstName}
                style={styles.input}
                placeholder="First name"
                placeholderTextColor={Colors.textMuted}
                autoCapitalize="words"
              />
              <Text style={styles.label}>Last Name</Text>
              <TextInput
                value={lastName}
                onChangeText={setLastName}
                style={styles.input}
                placeholder="Last name"
                placeholderTextColor={Colors.textMuted}
                autoCapitalize="words"
              />
            </View>

            {/* Certification */}
            <View style={styles.formSection}>
              <Text style={styles.label}>Certification</Text>
              <TouchableOpacity
                style={[styles.toggleRow, isCertified && styles.toggleRowActive]}
                onPress={() => setIsCertified((v) => !v)}
                activeOpacity={0.7}
              >
                {isCertified ? (
                  <ShieldCheck size={22} color={Colors.success} />
                ) : (
                  <Shield size={22} color={Colors.warning} />
                )}
                <Text
                  style={[
                    styles.toggleLabel,
                    { color: isCertified ? Colors.success : Colors.warning },
                  ]}
                >
                  {isCertified ? 'Certified' : 'Not Certified'}
                </Text>
                <Text style={styles.toggleHint}>Tap to toggle</Text>
              </TouchableOpacity>
            </View>

            {/* Club selection */}
            <View style={styles.formSection}>
              <Text style={styles.label}>Club</Text>
              <FilterDropdown
                label="Club"
                value={coachClub}
                options={clubDropdownOptions}
                onSelect={(v) => {
                  setCoachClub(v);
                  if (v) {
                    setTeamDrafts((prev) =>
                      prev.filter((t) => (t.club || '').toLowerCase() === v.toLowerCase()),
                    );
                  }
                }}
                placeholder="Select Club"
              />
            </View>

            {/* Team assignments — inline picker */}
            <View style={styles.formSection}>
              <Text style={styles.label}>Teams</Text>
              {!coachClub ? (
                <Text style={styles.emptyAssign}>
                  Select a club above to see available teams.
                </Text>
              ) : filteredAvailableTeams.length === 0 ? (
                <Text style={styles.emptyAssign}>
                  No teams found for {coachClub}. Try a different club.
                </Text>
              ) : (
                filteredAvailableTeams.map((t) => {
                  const k = teamKey(t);
                  const selected = teamDrafts.some((d) => teamKey(d) === k);
                  return (
                    <TouchableOpacity
                      key={k}
                      style={[styles.pickerRow, selected && styles.pickerRowSelected]}
                      onPress={() => toggleTeamDraft(t)}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={styles.pickerName}>
                          {t.club} {t.ageGroup} {t.teamName}
                        </Text>
                        <Text style={styles.pickerMeta}>
                          {t.division}{t.division ? ' • ' : ''}{t.ageGroup}
                        </Text>
                      </View>
                      {selected && <Check size={20} color={Colors.success} />}
                    </TouchableOpacity>
                  );
                })
              )}
              {teamDrafts.length > 0 && (
                <View style={{ marginTop: 14 }}>
                  <Text style={[styles.label, { marginBottom: 8 }]}>
                    Selected ({teamDrafts.length})
                  </Text>
                  {teamDrafts.map((t) => (
                    <View key={teamKey(t)} style={styles.teamChip}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.teamChipName}>{t.teamName || 'Unnamed'}</Text>
                        <Text style={styles.teamChipMeta}>
                          {t.club} • {t.ageGroup} • {t.division}
                        </Text>
                      </View>
                      <TouchableOpacity onPress={() => toggleTeamDraft(t)} style={styles.iconBtn}>
                        <X size={16} color={Colors.textMuted} />
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
              )}
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>


      {/* Coach CSV import modal */}
      <CoachCSVImportModal
        visible={showImport}
        onClose={() => setShowImport(false)}
        onImport={importCoaches}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 14,
    backgroundColor: Colors.primary,
    gap: 12,
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  addBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.2)',
    marginLeft: 'auto',
  },
  importBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.2)',
    marginLeft: 8,
  },
  title: { fontSize: 20, fontWeight: '700' as const, color: Colors.white },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 40 },
  emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  emptyText: { fontSize: 16, color: Colors.textMuted },
  emptyState: { alignItems: 'center', paddingVertical: 40, gap: 8 },
  emptyStateTitle: { fontSize: 17, fontWeight: '600' as const, color: Colors.text, marginTop: 12 },
  emptyStateSub: { fontSize: 14, color: Colors.textMuted, textAlign: 'center', paddingHorizontal: 32 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 12,
  },
  photoWrap: {},
  photo: { width: 48, height: 48, borderRadius: 24, backgroundColor: Colors.surfaceAlt },
  photoPlaceholder: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowInfo: { flex: 1 },
  rowName: { fontSize: 16, fontWeight: '600' as const, color: Colors.text, marginBottom: 2 },
  rowMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 2 },
  rowMeta: { fontSize: 12, fontWeight: '500' as const },
  rowMetaDim: { fontSize: 12, color: Colors.textMuted, marginLeft: 4 },
  rowTeams: { fontSize: 12, color: Colors.textMuted, marginTop: 2 },
  rowActions: { flexDirection: 'row', gap: 4 },
  iconBtn: { padding: 8 },
  photoSection: { alignItems: 'center', marginBottom: 16 },
  bigPhotoWrap: { position: 'relative' },
  bigPhoto: { width: 110, height: 110, borderRadius: 55, backgroundColor: Colors.surfaceAlt },
  bigPhotoPlaceholder: {
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: Colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: Colors.border,
    borderStyle: 'dashed' as const,
  },
  cameraBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: Colors.surface,
  },
  photoHint: { fontSize: 13, color: Colors.textMuted, marginTop: 8 },
  requiredStar: { color: '#dc2626', fontWeight: '700' as const },
  formSection: { marginBottom: 20 },
  label: {
    fontSize: 13,
    fontWeight: '600' as const,
    color: Colors.textMuted,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
    marginBottom: 8,
    marginTop: 6,
  },
  input: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: Colors.text,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 6,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: Colors.surfaceAlt,
    borderRadius: 12,
    padding: 14,
  },
  toggleRowActive: { backgroundColor: Colors.successLight },
  toggleLabel: { fontSize: 16, fontWeight: '600' as const, flex: 1 },
  toggleHint: { fontSize: 12, color: Colors.textMuted },
  assignHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  assignBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.primaryLight,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  assignBtnText: { fontSize: 13, fontWeight: '600' as const, color: Colors.primary },
  assignBtnDisabled: { opacity: 0.4 },
  emptyAssign: { fontSize: 13, color: Colors.textMuted, fontStyle: 'italic' as const, padding: 8 },
  teamChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  teamChipName: { fontSize: 14, fontWeight: '600' as const, color: Colors.text },
  teamChipMeta: { fontSize: 12, color: Colors.textMuted, marginTop: 2 },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  pickerRowSelected: { borderColor: Colors.success, backgroundColor: Colors.successLight },
  pickerName: { fontSize: 15, fontWeight: '600' as const, color: Colors.text },
  pickerMeta: { fontSize: 12, color: Colors.textMuted, marginTop: 2 },
  clubFilterBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 8,
  },
  clubFilterScroll: {
    flexDirection: 'row',
    gap: 8,
    paddingRight: 16,
  },
  clubFilterChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 18,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  clubFilterChipActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  clubFilterChipText: {
    fontSize: 13,
    fontWeight: '500' as const,
    color: Colors.text,
  },
  clubFilterChipTextActive: {
    color: Colors.white,
    fontWeight: '600' as const,
  },
});
