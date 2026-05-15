import React, { useCallback, useMemo, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  ActivityIndicator,
  RefreshControl,
  Keyboard,
} from 'react-native';
import { Player, CheckInStatusFilter } from '@/types';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Search } from 'lucide-react-native';
import { useRegistration } from '@/contexts/RegistrationContext';
import FilterDropdown from '@/components/FilterDropdown';
import PlayerCard from '@/components/PlayerCard';
import StatsBar from '@/components/StatsBar';
import CloudSyncBanner from '@/components/CloudSyncBanner';
import OrgMovedBanner from '@/components/OrgMovedBanner';
import Colors from '@/constants/colors';

// FilterDropdown identifies its rows by `id` and surfaces `name` to the
// user. The names here are matched against in the onSelect handler to
// decide which CheckInStatusFilter value to store.
const STATUS_FILTER_OPTIONS = [
  { id: 'pending', name: 'Pending' },
  { id: 'checkedIn', name: 'Checked In' },
];

const CLUB_ALIASES: Record<string, string> = {
  'cache valley pirates': 'Cache Valley',
  'mountain ridge black': 'Mountain Ridge',
  mvp: 'Mountain Valley Powerhouse',
  provo: 'Provo Steelers',
  richfield: 'Richfield Broncos',
  westlake: 'Westlake Drua',
};

function canonicalClubName(club: string | null | undefined): string {
  const stripped = (club || '')
    .toString()
    .trim()
    .replace(/^little\s+/i, '')
    .replace(/\s+/g, ' ');

  if (!stripped) return '';
  return CLUB_ALIASES[stripped.toLowerCase()] ?? stripped;
}

function displayClubName(club: string | null | undefined): string {
  const canonical = canonicalClubName(club);
  return canonical ? `Little ${canonical}` : '';
}

function clubFilterKey(club: string | null | undefined): string {
  return canonicalClubName(club).toLowerCase();
}

export default function CheckInScreen() {
  const insets = useSafeAreaInsets();
  const {
    players,
    filters,
    setFilters,
    searchQuery,
    setSearchQuery,
    teams,
    ageGroups,
    divisions,
    isLoading,
    refreshData,
  } = useRegistration();

  const [refreshing, setRefreshing] = React.useState(false);

  const playerClubOptions = useMemo(
    () =>
      Array.from(
        new Set(
          players
            .map((p) => displayClubName(p.club))
            .filter((club): club is string => Boolean(club)),
        ),
      ).sort(),
    [players],
  );

  const filteredPlayers = useMemo(() => {
    let result = players;

    const normalizeStr = (v: string | undefined | null) => (v || '').toString().trim().toLowerCase();
    const normalizeAge = (v: string | undefined | null): string => {
      const raw = (v || '').toString().toUpperCase();
      if (!raw.trim()) return '';
      const match = raw.match(/(\d{1,2})/);
      if (match) return `U${parseInt(match[1], 10)}`;
      return raw.replace(/\s+/g, '');
    };

    if (filters.club) {
      const target = clubFilterKey(filters.club);
      result = result.filter((p) => clubFilterKey(p.club) === target);
    }
    if (filters.ageGroup) {
      const target = normalizeAge(filters.ageGroup);
      result = result.filter((p) => normalizeAge(p.ageGroup || p.calculatedAgeGroup || '') === target);
    }
    if (filters.division) {
      const target = normalizeStr(filters.division);
      result = result.filter((p) => normalizeStr(p.division) === target);
    }
    if (filters.teamName) {
      result = result.filter((p) => playerHasTeam(p.teamName, filters.teamName));
    }
    if (filters.status === 'checkedIn') {
      result = result.filter((p) => p.checkedIn);
    } else if (filters.status === 'pending') {
      result = result.filter((p) => !p.checkedIn);
    }
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      result = result.filter(
        (p) =>
          p.firstName.toLowerCase().includes(query) ||
          p.lastName.toLowerCase().includes(query) ||
          `${p.firstName} ${p.lastName}`.toLowerCase().includes(query) ||
          displayClubName(p.club).toLowerCase().includes(query),
      );
    }

    return result.sort((a, b) => {
      if (a.checkedIn !== b.checkedIn) return a.checkedIn ? 1 : -1;
      return `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`);
    });
  }, [players, filters, searchQuery]);

  const stats = useMemo(() => {
    const total = filteredPlayers.length;
    const checkedIn = filteredPlayers.filter((p) => p.checkedIn).length;
    return { total, checkedIn, pending: total - checkedIn };
  }, [filteredPlayers]);

  // Cascade team options based on selected club, age group, and division
  const teamNames = useMemo(() => {
    const normalizeAge = (s: string | null | undefined) =>
      (s || '').toString().toUpperCase().replace(/\s+/g, '').replace(/^U(\d+)$/, '$1U').replace(/^(\d+)U$/, '$1U');
    const normalize = (s: string | null | undefined) => (s || '').toString().trim().toLowerCase();

    const targetClub = clubFilterKey(filters.club);
    const targetAge = normalizeAge(filters.ageGroup);
    const targetDivision = normalize(filters.division);

    const filtered = teams.filter((t) => {
      if (targetClub && clubFilterKey(t.club) !== targetClub) return false;
      if (targetAge && normalizeAge(t.ageGroup) !== targetAge) return false;
      if (targetDivision && normalize(t.division) !== targetDivision) return false;
      return true;
    });

    const seen = new Set<string>();
    const unique: typeof teams = [];
    for (const t of filtered) {
      const key = normalize(t.name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      unique.push(t);
    }
    return unique;
  }, [teams, filters.club, filters.ageGroup, filters.division]);

  useEffect(() => {
    if (!filters.teamName) return;
    const stillValid = teamNames.some((t) => t.name === filters.teamName);
    if (!stillValid) {
      console.log('[check-in] clearing team filter because it no longer matches filters');
      setFilters({ ...filters, teamName: null });
    }
  }, [teamNames, filters, setFilters]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    console.log('Pull-to-refresh triggered on Check-In screen');
    refreshData();
    setTimeout(() => setRefreshing(false), 1500);
  }, [refreshData]);

  const renderItem = useCallback(({ item }: { item: Player }) => (
    <PlayerCard player={item} />
  ), []);

  const keyExtractor = useCallback((item: Player) => item.id, []);

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={Colors.primary} />
        <Text style={styles.loadingText}>Loading players...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Text style={styles.title}>Player Check-In</Text>
        <Text style={styles.subtitle}>Tap a player to verify and check in</Text>
      </View>

      <View style={styles.filtersContainer}>
        <View style={styles.filterRow}>
          <FilterDropdown
            label="Club"
            value={filters.club}
            options={playerClubOptions}
            onSelect={(value) => setFilters({ ...filters, club: value })}
            placeholder="All Clubs"
            labelColor={Colors.white}
          />
          <View style={styles.filterSpacer} />
          <FilterDropdown
            label="Age"
            value={filters.ageGroup}
            options={ageGroups}
            onSelect={(value) => setFilters({ ...filters, ageGroup: value })}
            placeholder="All Ages"
            labelColor={Colors.white}
          />
          <View style={styles.filterSpacer} />
          <FilterDropdown
            label="Division"
            value={filters.division}
            options={divisions}
            onSelect={(value) => setFilters({ ...filters, division: value })}
            placeholder="All"
            labelColor={Colors.white}
          />
        </View>

        <View style={styles.filterRow}>
          {teams.length > 0 && (
            <>
              <FilterDropdown
                label="Team"
                value={filters.teamName || null}
                options={teamNames}
                onSelect={(value) => setFilters({ ...filters, teamName: value })}
                placeholder={teamNames.length === 0 ? 'No teams match' : 'All Teams'}
                labelColor={Colors.white}
              />
              <View style={styles.filterSpacer} />
            </>
          )}
          <FilterDropdown
            label="Status"
            value={
              filters.status === 'checkedIn'
                ? 'Checked In'
                : filters.status === 'pending'
                ? 'Pending'
                : null
            }
            options={STATUS_FILTER_OPTIONS}
            onSelect={(value) => {
              const next: CheckInStatusFilter | null =
                value === 'Checked In' ? 'checkedIn' : value === 'Pending' ? 'pending' : null;
              setFilters({ ...filters, status: next });
            }}
            placeholder="All"
            labelColor={Colors.white}
          />
        </View>

        <View style={styles.searchContainer}>
          <Search size={20} color={Colors.textMuted} style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search by player name..."
            placeholderTextColor={Colors.textMuted}
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={() => Keyboard.dismiss()}
            testID="search-input"
          />
        </View>
      </View>

      <View style={styles.content}>
        <OrgMovedBanner />
        <CloudSyncBanner />
        <StatsBar
          total={stats.total}
          checkedIn={stats.checkedIn}
          pending={stats.pending}
        />

        <FlatList
          data={filteredPlayers}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={styles.listContent}
          initialNumToRender={15}
          maxToRenderPerBatch={10}
          windowSize={5}
          removeClippedSubviews={true}
          updateCellsBatchingPeriod={50}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={Colors.primary}
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyTitle}>No Players Found</Text>
              <Text style={styles.emptyText}>
                {searchQuery
                  ? 'Try adjusting your search or filters'
                  : 'No players match the selected filters'}
              </Text>
            </View>
          }
        />
      </View>
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
    paddingBottom: 12,
    backgroundColor: Colors.primary,
  },
  title: {
    fontSize: 24,
    fontWeight: '700' as const,
    color: Colors.white,
  },
  subtitle: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.8)',
    marginTop: 2,
  },
  filtersContainer: {
    backgroundColor: Colors.primary,
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderBottomLeftRadius: 24,
    borderBottomRightRadius: 24,
  },
  filterRow: {
    flexDirection: 'row',
    marginBottom: 12,
  },
  filterSpacer: {
    width: 8,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: 12,
    paddingHorizontal: 14,
  },
  searchIcon: {
    marginRight: 10,
  },
  searchInput: {
    flex: 1,
    height: 46,
    fontSize: 16,
    color: Colors.text,
  },
  content: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  listContent: {
    paddingBottom: 20,
  },
  emptyContainer: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600' as const,
    color: Colors.text,
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
});
