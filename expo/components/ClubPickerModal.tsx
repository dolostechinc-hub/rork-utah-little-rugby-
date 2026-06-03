import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  Modal,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  FlatList,
  Platform,
} from 'react-native';
import { X, Search, Building2, Check } from 'lucide-react-native';
import Colors from '@/constants/colors';
import type { Club } from '@/types';

interface ClubPickerModalProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (clubName: string) => void;
  currentClub: string;
  clubs: Club[];
}

export default function ClubPickerModal({
  visible,
  onClose,
  onSelect,
  currentClub,
  clubs,
}: ClubPickerModalProps) {
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (visible) setSearch('');
  }, [visible]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return clubs;
    return clubs.filter((c) => c.name.toLowerCase().includes(q));
  }, [clubs, search]);

  const handleSelect = (name: string) => {
    onSelect(name);
    onClose();
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Building2 size={22} color={Colors.primary} />
            <Text style={styles.headerTitle}>Change Club</Text>
          </View>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn} testID="club-picker-close">
            <X size={22} color={Colors.text} />
          </TouchableOpacity>
        </View>

        {currentClub ? (
          <View style={styles.currentCard}>
            <Text style={styles.currentLabel}>Current Club</Text>
            <Text style={styles.currentName}>{currentClub}</Text>
          </View>
        ) : null}

        <View style={styles.searchSection}>
          <View style={styles.searchRow}>
            <Search size={18} color={Colors.textMuted} />
            <TextInput
              style={styles.searchInput}
              value={search}
              onChangeText={setSearch}
              placeholder="Search clubs..."
              placeholderTextColor={Colors.textMuted}
              autoCapitalize="words"
              autoCorrect={false}
              testID="club-picker-search"
            />
          </View>
        </View>

        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id || item.name}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => {
            const isCurrent = item.name === currentClub;
            return (
              <TouchableOpacity
                style={[styles.row, isCurrent && styles.rowActive]}
                onPress={() => handleSelect(item.name)}
                activeOpacity={0.7}
                testID={`club-row-${item.name}`}
              >
                <Building2 size={18} color={isCurrent ? Colors.primary : Colors.textSecondary} />
                <Text style={[styles.rowName, isCurrent && styles.rowNameActive]}>
                  {item.name}
                </Text>
                {isCurrent && <Check size={18} color={Colors.primary} />}
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Building2 size={36} color={Colors.textMuted} />
              <Text style={styles.emptyTitle}>No clubs found</Text>
              <Text style={styles.emptyText}>
                {search.trim()
                  ? `No clubs matching "${search}"`
                  : 'No clubs are available yet.'}
              </Text>
            </View>
          }
        />
      </View>
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
  currentCard: {
    marginHorizontal: 20,
    marginTop: 12,
    padding: 14,
    borderRadius: 12,
    backgroundColor: Colors.primaryLight,
    borderWidth: 1,
    borderColor: Colors.primary,
  },
  currentLabel: { fontSize: 12, color: Colors.primary, fontWeight: '600' as const, marginBottom: 2 },
  currentName: { fontSize: 16, color: Colors.text, fontWeight: '700' as const },
  searchSection: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 4 },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: Colors.text,
    paddingVertical: Platform.OS === 'ios' ? 12 : 10,
  },
  listContent: { paddingHorizontal: 20, paddingBottom: 40 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    backgroundColor: Colors.surface,
    borderRadius: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 12,
  },
  rowActive: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryLight,
  },
  rowName: { flex: 1, fontSize: 15, fontWeight: '600' as const, color: Colors.text },
  rowNameActive: { color: Colors.primary },
  empty: { alignItems: 'center', paddingVertical: 40, paddingHorizontal: 20 },
  emptyTitle: { fontSize: 15, fontWeight: '600' as const, color: Colors.text, marginTop: 10 },
  emptyText: { fontSize: 13, color: Colors.textSecondary, textAlign: 'center', marginTop: 6 },
});
