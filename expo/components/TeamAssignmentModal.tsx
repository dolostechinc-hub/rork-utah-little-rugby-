import React, { useMemo, useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  Modal,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  FlatList,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { X, Users, Plus, Check } from 'lucide-react-native';
import Colors from '@/constants/colors';
import { parseTeamAssignments, serializeTeamAssignments } from '@/utils/teamAssignments';
import { normalizeAgeGroup } from '@/utils/playerUtils';

export interface TeamOption {
  id: string;
  name: string;
  club?: string;
  ageGroup?: string;
  division?: string;
}

interface TeamAssignmentModalProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (teamName: string) => void;
  onClear: () => void;
  currentTeamName: string | null | undefined;
  playerClub: string;
  playerAgeGroup: string;
  allTeams: TeamOption[];
}

export default function TeamAssignmentModal({
  visible,
  onClose,
  onSelect,
  onClear,
  currentTeamName,
  playerClub,
  playerAgeGroup,
  allTeams,
}: TeamAssignmentModalProps) {
  const [customName, setCustomName] = useState<string>('');
  const [selectedNames, setSelectedNames] = useState<string[]>([]);

  useEffect(() => {
    if (visible) {
      setSelectedNames(parseTeamAssignments(currentTeamName));
    }
  }, [currentTeamName, visible]);



  const suggestedTeams = useMemo(() => {
    const normClub = (playerClub || '').trim().toLowerCase();
    const normAge = normalizeAgeGroup(playerAgeGroup);

    const matches = allTeams.filter((t) => {
      const teamClub = (t.club || '').trim().toLowerCase();
      const teamAge = normalizeAgeGroup(t.ageGroup);
      if (normClub && teamClub && teamClub !== normClub) return false;
      if (normAge && teamAge && teamAge !== normAge) return false;
      return true;
    });

    const seen = new Set<string>();
    const unique: TeamOption[] = [];
    for (const t of matches) {
      const key = (t.name || '').trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      unique.push(t);
    }
    return unique.sort((a, b) => a.name.localeCompare(b.name));
  }, [allTeams, playerClub, playerAgeGroup]);

  const suggestedColorNames = useMemo(() => {
    const base = `${playerClub || ''} ${playerAgeGroup || ''}`.trim();
    if (!base) return [] as string[];
    return ['White', 'Blue', 'Navy', 'Orange', 'Red', 'Black', 'Green', 'Gold'].map(
      (color) => `${base} ${color}`,
    );
  }, [playerClub, playerAgeGroup]);

  const handleSelect = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const exists = selectedNames.some((teamName) => teamName.toLowerCase() === trimmed.toLowerCase());
      const next = exists
        ? selectedNames.filter((teamName) => teamName.toLowerCase() !== trimmed.toLowerCase())
        : [...selectedNames, trimmed];
      console.log('[TeamAssignment] toggling team:', trimmed, 'next:', next);
      setSelectedNames(next);
      onSelect(serializeTeamAssignments(next));
      setCustomName('');
    },
    [onSelect, selectedNames],
  );

  const handleClear = useCallback(() => {
    console.log('[TeamAssignment] clearing team');
    setSelectedNames([]);
    onClear();
    setCustomName('');
  }, [onClear]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Users size={22} color={Colors.primary} />
            <Text style={styles.headerTitle}>Assign Teams</Text>
          </View>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn} testID="team-assign-close">
            <X size={22} color={Colors.text} />
          </TouchableOpacity>
        </View>

        <View style={styles.contextRow}>
          <Text style={styles.contextLabel}>Club</Text>
          <Text style={styles.contextValue}>{playerClub || '—'}</Text>
          <View style={styles.contextDot} />
          <Text style={styles.contextLabel}>Age</Text>
          <Text style={styles.contextValue}>{playerAgeGroup || '—'}</Text>
        </View>

        {selectedNames.length > 0 ? (
          <View style={styles.currentCard}>
            <View style={{ flex: 1 }}>
              <Text style={styles.currentLabel}>Currently Assigned</Text>
              <Text style={styles.currentName}>{selectedNames.join(', ')}</Text>
            </View>
            <TouchableOpacity onPress={handleClear} style={styles.clearBtn} testID="team-assign-clear">
              <Text style={styles.clearBtnText}>Remove All</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <View style={styles.inputSection}>
          <Text style={styles.sectionLabel}>Add Custom Team Name</Text>
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              value={customName}
              onChangeText={setCustomName}
              placeholder={`e.g. ${playerClub || 'Club'} ${playerAgeGroup || 'U14'} Blue`}
              placeholderTextColor={Colors.textMuted}
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={() => handleSelect(customName)}
              testID="team-assign-input"
            />
            <TouchableOpacity
              style={[styles.addBtn, !customName.trim() && styles.addBtnDisabled]}
              onPress={() => handleSelect(customName)}
              disabled={!customName.trim()}
              testID="team-assign-save"
            >
              <Plus size={18} color={Colors.white} />
              <Text style={styles.addBtnText}>Add</Text>
            </TouchableOpacity>
          </View>

          {suggestedColorNames.length > 0 && (
            <View style={styles.suggestedChips}>
              {suggestedColorNames.map((name) => (
                <TouchableOpacity
                  key={name}
                  style={styles.chip}
                  onPress={() => handleSelect(name)}
                  testID={`team-chip-${name}`}
                >
                  <Text style={styles.chipText}>{name}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>

        <View style={styles.listHeader}>
          <Text style={styles.sectionLabel}>Existing Teams</Text>
          <Text style={styles.listHeaderHint}>
            {suggestedTeams.length > 0
              ? `${suggestedTeams.length} match — tap multiple`
              : 'No matching teams yet'}
          </Text>
        </View>

        <FlatList
          data={suggestedTeams}
          keyExtractor={(item) => item.id || item.name}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => {
            const isCurrent = selectedNames.some(
              (teamName) => teamName.toLowerCase() === item.name.trim().toLowerCase(),
            );
            return (
              <TouchableOpacity
                style={[styles.teamRow, isCurrent && styles.teamRowActive]}
                onPress={() => handleSelect(item.name)}
                activeOpacity={0.7}
                testID={`team-row-${item.name}`}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.teamName}>{item.name}</Text>
                  {(item.division || item.club) && (
                    <Text style={styles.teamMeta}>
                      {[item.club, item.ageGroup, item.division].filter(Boolean).join(' • ')}
                    </Text>
                  )}
                </View>
                {isCurrent && <Check size={20} color={Colors.primary} />}
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Users size={36} color={Colors.textMuted} />
              <Text style={styles.emptyTitle}>No existing teams</Text>
              <Text style={styles.emptyText}>
                Type a team name above to create the first one for this club & age group.
              </Text>
            </View>
          }
        />
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerTitle: { fontSize: 18, fontWeight: '700' as const, color: Colors.text },
  closeBtn: { padding: 6 },
  contextRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    gap: 8,
    flexWrap: 'wrap',
  },
  contextLabel: { fontSize: 12, color: Colors.textMuted, textTransform: 'uppercase', fontWeight: '600' as const },
  contextValue: { fontSize: 14, color: Colors.text, fontWeight: '600' as const },
  contextDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: Colors.border, marginHorizontal: 4 },
  currentCard: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 20,
    marginBottom: 12,
    padding: 14,
    borderRadius: 12,
    backgroundColor: Colors.primaryLight,
    borderWidth: 1,
    borderColor: Colors.primary,
  },
  currentLabel: { fontSize: 12, color: Colors.primary, fontWeight: '600' as const, marginBottom: 2 },
  currentName: { fontSize: 16, color: Colors.text, fontWeight: '700' as const },
  clearBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: Colors.white },
  clearBtnText: { color: Colors.error, fontWeight: '600' as const, fontSize: 13 },
  inputSection: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12 },
  sectionLabel: { fontSize: 13, fontWeight: '600' as const, color: Colors.textSecondary, marginBottom: 8 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  input: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 15,
    color: Colors.text,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
  },
  addBtnDisabled: { backgroundColor: Colors.textMuted },
  addBtnText: { color: Colors.white, fontWeight: '600' as const, fontSize: 14 },
  suggestedChips: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 10, gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: Colors.surfaceAlt,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  chipText: { fontSize: 12, color: Colors.text, fontWeight: '500' as const },
  listHeader: {
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  listHeaderHint: { fontSize: 12, color: Colors.textMuted },
  listContent: { paddingHorizontal: 20, paddingBottom: 40 },
  teamRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    backgroundColor: Colors.surface,
    borderRadius: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  teamRowActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryLight },
  teamName: { fontSize: 15, fontWeight: '600' as const, color: Colors.text },
  teamMeta: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  empty: { alignItems: 'center', paddingVertical: 40, paddingHorizontal: 20 },
  emptyTitle: { fontSize: 15, fontWeight: '600' as const, color: Colors.text, marginTop: 10 },
  emptyText: { fontSize: 13, color: Colors.textSecondary, textAlign: 'center', marginTop: 6 },
});
