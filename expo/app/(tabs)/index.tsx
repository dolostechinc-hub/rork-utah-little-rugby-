import React, { useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { Player } from '@/types';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Search } from 'lucide-react-native';
import { useRegistration } from '@/contexts/RegistrationContext';
import FilterDropdown from '@/components/FilterDropdown';
import PlayerCard from '@/components/PlayerCard';
import StatsBar from '@/components/StatsBar';
import Colors from '@/constants/colors';

export default function CheckInScreen() {
  const insets = useSafeAreaInsets();
  const {
    filteredPlayers,
    filters,
    setFilters,
    searchQuery,
    setSearchQuery,
    clubs,
    teams,
    ageGroups,
    divisions,
    isLoading,
    stats,
    refreshData,
    isFetching,
  } = useRegistration();

  const [refreshing, setRefreshing] = React.useState(false);

  // Use teams from context directly
  const teamNames = teams;

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
            options={clubs}
            onSelect={(value) => setFilters({ ...filters, club: value })}
            placeholder="All Clubs"
          />
          <View style={styles.filterSpacer} />
          <FilterDropdown
            label="Age"
            value={filters.ageGroup}
            options={ageGroups}
            onSelect={(value) => setFilters({ ...filters, ageGroup: value })}
            placeholder="All Ages"
          />
          <View style={styles.filterSpacer} />
          <FilterDropdown
            label="Division"
            value={filters.division}
            options={divisions}
            onSelect={(value) => setFilters({ ...filters, division: value })}
            placeholder="All"
          />
        </View>

        {teamNames.length > 0 && (
          <View style={styles.filterRow}>
            <FilterDropdown
              label="Team"
              value={filters.teamName || null}
              options={teamNames}
              onSelect={(value) => setFilters({ ...filters, teamName: value })}
              placeholder="All Teams"
            />
          </View>
        )}

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
            testID="search-input"
          />
        </View>
      </View>

      <View style={styles.content}>
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
