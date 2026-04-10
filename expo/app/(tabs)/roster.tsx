import React, { useState, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Image,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  Search,
  Users,
  CheckCircle2,
  Circle,
  ChevronRight,
  X,
  Filter,
  User,
  Shirt,
  ArrowUp,
} from 'lucide-react-native';

import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRegistration } from '@/contexts/RegistrationContext';
import FilterDropdown from '@/components/FilterDropdown';
import Colors from '@/constants/colors';
import { Player, RestrictionStatus } from '@/types';
import { getRestrictionStatusLabel, getRestrictionStatusColor } from '@/utils/playerUtils';

const ItemSeparator = React.memo(() => <View style={separatorStyle.separator} />);
const separatorStyle = StyleSheet.create({ separator: { height: 1, backgroundColor: Colors.border, marginLeft: 56 } });

export default function RosterScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const {
    players,
    clubs,
    teams,
    ageGroups,
    divisions,
    isLoading,
    refreshData,
  } = useRegistration();

  // Use teams from context directly
  const teamNames = teams;

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedClub, setSelectedClub] = useState<string | null>(null);
  const [selectedAgeGroup, setSelectedAgeGroup] = useState<string | null>(null);
  const [selectedDivision, setSelectedDivision] = useState<string | null>(null);
  const [selectedTeamName, setSelectedTeamName] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const filteredPlayers = useMemo(() => {
    let result = players;

    if (selectedClub) {
      result = result.filter(p => p.club === selectedClub);
    }
    if (selectedAgeGroup) {
      result = result.filter(p => {
        const effectiveAgeGroup = p.calculatedAgeGroup || p.ageGroup;
        return effectiveAgeGroup === selectedAgeGroup;
      });
    }
    if (selectedDivision) {
      result = result.filter(p => p.division === selectedDivision);
    }
    if (selectedTeamName) {
      result = result.filter(p => p.teamName === selectedTeamName);
    }
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      result = result.filter(p =>
        p.firstName.toLowerCase().includes(query) ||
        p.lastName.toLowerCase().includes(query) ||
        `${p.firstName} ${p.lastName}`.toLowerCase().includes(query) ||
        p.club.toLowerCase().includes(query)
      );
    }

    return result.sort((a, b) => 
      `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`)
    );
  }, [players, selectedClub, selectedAgeGroup, selectedDivision, selectedTeamName, searchQuery]);

  const stats = useMemo(() => {
    const total = filteredPlayers.length;
    const checkedIn = filteredPlayers.filter(p => p.checkedIn).length;
    return { total, checkedIn };
  }, [filteredPlayers]);

  const hasActiveFilters = selectedClub || selectedAgeGroup || selectedDivision || selectedTeamName;

  const clearFilters = useCallback(() => {
    setSelectedClub(null);
    setSelectedAgeGroup(null);
    setSelectedDivision(null);
    setSelectedTeamName(null);
  }, []);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    refreshData();
    setTimeout(() => setRefreshing(false), 1000);
  }, [refreshData]);

  const keyExtractor = useCallback((item: Player) => item.id, []);

  const handlePlayerPress = useCallback((player: Player) => {
    router.push(`/player/${player.id}`);
  }, [router]);

  const renderPlayerItem = useCallback(({ item }: { item: Player }) => {
    const hasPhoto = item.photoUri && item.isAgeVerified;
    const restrictionStatus = item.restrictionStatus as RestrictionStatus | undefined;
    
    return (
      <TouchableOpacity
        style={styles.playerRow}
        onPress={() => handlePlayerPress(item)}
        activeOpacity={0.7}
      >
        <View style={styles.thumbnailContainer}>
          {hasPhoto ? (
            <Image source={{ uri: item.photoUri! }} style={styles.thumbnail} />
          ) : (
            <View style={styles.thumbnailPlaceholder}>
              <User size={20} color={Colors.textMuted} />
            </View>
          )}
          {hasPhoto && (
            <View style={styles.verifiedBadge}>
              <CheckCircle2 size={12} color={Colors.white} />
            </View>
          )}
        </View>

        <View style={styles.playerInfo}>
          <View style={styles.nameRow}>
            <Text style={styles.playerName}>
              {item.firstName} {item.lastName}
            </Text>
            {restrictionStatus === 'penny_player' && (
              <View style={styles.iconBadge}>
                <Shirt size={16} color="#DC2626" fill="#DC2626" fillOpacity={0.2} />
              </View>
            )}
            {restrictionStatus === 'play_up' && (
              <View style={styles.iconBadge}>
                <ArrowUp size={18} color="#2563EB" />
              </View>
            )}
          </View>
          <View style={styles.playerMeta}>
            <Text style={styles.playerClub}>{item.club}</Text>
            <Text style={styles.metaDot}>•</Text>
            <Text style={styles.playerAge}>{item.calculatedAgeGroup || item.ageGroup}</Text>
            <Text style={styles.metaDot}>•</Text>
            <Text style={styles.playerDivision}>{item.division}</Text>
          </View>
          {item.weight && (
            <Text style={styles.playerWeight}>{item.weight} lbs</Text>
          )}
          {restrictionStatus && restrictionStatus !== 'none' && (
            <View style={[styles.restrictionBadge, { backgroundColor: getRestrictionStatusColor(restrictionStatus) + '20' }]}>
              <Text style={[styles.restrictionText, { color: getRestrictionStatusColor(restrictionStatus) }]}>
                {getRestrictionStatusLabel(restrictionStatus)}
              </Text>
            </View>
          )}
        </View>

        <View style={styles.statusContainer}>
          <View style={styles.statusRow}>
            {item.checkedIn ? (
              <CheckCircle2 size={20} color={Colors.success} />
            ) : (
              <Circle size={20} color={Colors.border} />
            )}
          </View>
        </View>

        <ChevronRight size={20} color={Colors.textMuted} />
      </TouchableOpacity>
    );
  }, [handlePlayerPress]);

  const availableTeams = useMemo(() => {
    if (!selectedClub) return teamNames;
    return teamNames.filter(t => t.club === selectedClub);
  }, [teamNames, selectedClub]);

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={Colors.primary} />
        <Text style={styles.loadingText}>Loading roster...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <View style={styles.headerTop}>
          <Users size={28} color={Colors.white} />
          <Text style={styles.title}>Player Roster</Text>
        </View>
        <Text style={styles.subtitle}>
          {stats.checkedIn} of {stats.total} players checked in
        </Text>
      </View>

      <View style={styles.searchSection}>
        <View style={styles.searchContainer}>
          <Search size={20} color={Colors.textMuted} style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search by name or club..."
            placeholderTextColor={Colors.textMuted}
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCapitalize="none"
            autoCorrect={false}
            testID="roster-search-input"
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')}>
              <X size={18} color={Colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>

        <TouchableOpacity
          style={[styles.filterToggle, hasActiveFilters && styles.filterToggleActive]}
          onPress={() => setShowFilters(!showFilters)}
        >
          <Filter size={20} color={hasActiveFilters ? Colors.primary : Colors.textSecondary} />
        </TouchableOpacity>
      </View>

      {showFilters && (
        <View style={styles.filtersContainer}>
          <View style={styles.filterRow}>
            <FilterDropdown
              label="Club"
              value={selectedClub}
              options={clubs}
              onSelect={(val) => {
                setSelectedClub(val);
                // Clear team if it doesn't belong to the new club
                if (selectedTeamName) {
                  const team = teamNames.find(t => t.name === selectedTeamName);
                  if (team && team.club !== val) {
                    setSelectedTeamName(null);
                  }
                }
              }}
              placeholder="All Clubs"
            />
            <View style={styles.filterSpacer} />
            <FilterDropdown
              label="Age"
              value={selectedAgeGroup}
              options={ageGroups}
              onSelect={setSelectedAgeGroup}
              placeholder="All Ages"
            />
            <View style={styles.filterSpacer} />
            <FilterDropdown
              label="Division"
              value={selectedDivision}
              options={divisions}
              onSelect={setSelectedDivision}
              placeholder="All"
            />
          </View>
          {teamNames.length > 0 && (
            <View style={styles.filterRowSecond}>
              <FilterDropdown
                label="Team"
                value={selectedTeamName}
                options={availableTeams}
                onSelect={setSelectedTeamName}
                placeholder="All Teams"
              />
            </View>
          )}
          {hasActiveFilters && (
            <TouchableOpacity style={styles.clearFiltersButton} onPress={clearFilters}>
              <X size={14} color={Colors.primary} />
              <Text style={styles.clearFiltersText}>Clear Filters</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      <FlatList
        data={filteredPlayers}
        keyExtractor={keyExtractor}
        renderItem={renderPlayerItem}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
        initialNumToRender={15}
        maxToRenderPerBatch={10}
        windowSize={5}
        removeClippedSubviews={true}
        updateCellsBatchingPeriod={50}
        ItemSeparatorComponent={ItemSeparator}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Colors.primary}
          />
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Users size={48} color={Colors.textMuted} />
            <Text style={styles.emptyTitle}>No Players Found</Text>
            <Text style={styles.emptyText}>
              {searchQuery || hasActiveFilters
                ? 'Try adjusting your search or filters'
                : 'No players in the roster yet'}
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.background,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
    color: Colors.textSecondary,
  },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 16,
    backgroundColor: Colors.primary,
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 4,
  },
  title: {
    fontSize: 24,
    fontWeight: '700' as const,
    color: Colors.white,
  },
  subtitle: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.8)',
    marginLeft: 38,
  },
  searchSection: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 10,
  },
  searchContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.background,
    borderRadius: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    height: 42,
    fontSize: 16,
    color: Colors.text,
  },
  filterToggle: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: Colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  filterToggleActive: {
    backgroundColor: Colors.primaryLight,
    borderColor: Colors.primary,
  },
  filtersContainer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  filterRow: {
    flexDirection: 'row',
  },
  filterRowSecond: {
    marginTop: 10,
  },
  filterSpacer: {
    width: 8,
  },
  clearFiltersButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
    paddingVertical: 6,
    gap: 4,
  },
  clearFiltersText: {
    fontSize: 13,
    fontWeight: '500' as const,
    color: Colors.primary,
  },
  listContent: {
    paddingVertical: 8,
  },
  playerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: Colors.surface,
  },
  thumbnailContainer: {
    position: 'relative',
    marginRight: 12,
  },
  thumbnail: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Colors.surfaceAlt,
  },
  thumbnailPlaceholder: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  verifiedBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: Colors.success,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: Colors.surface,
  },
  playerInfo: {
    flex: 1,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
    flexWrap: 'wrap',
  },
  iconBadge: {
    marginLeft: 6,
    justifyContent: 'center',
  },
  playerName: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: Colors.text,
  },
  playerMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  playerClub: {
    fontSize: 13,
    color: Colors.primary,
    fontWeight: '500' as const,
  },
  metaDot: {
    fontSize: 13,
    color: Colors.textMuted,
    marginHorizontal: 6,
  },
  playerAge: {
    fontSize: 13,
    color: Colors.textSecondary,
  },
  playerDivision: {
    fontSize: 13,
    color: Colors.textSecondary,
  },
  playerWeight: {
    fontSize: 12,
    color: Colors.textMuted,
    marginTop: 2,
  },
  restrictionBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    marginTop: 4,
  },
  restrictionText: {
    fontSize: 10,
    fontWeight: '600' as const,
  },
  statusContainer: {
    marginRight: 8,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  pennyIndicator: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#FEE2E2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playUpIndicator: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#DBEAFE',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyContainer: {
    alignItems: 'center',
    paddingVertical: 60,
    paddingHorizontal: 40,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600' as const,
    color: Colors.text,
    marginTop: 16,
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
});
