import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Users } from 'lucide-react-native';
import Colors from '@/constants/colors';
import type { Coach, CoachTeam } from '@/types';
import CoachCard from './CoachCard';
import { normalizeAgeGroup } from '@/utils/playerUtils';

// Same club normalization used by roster and check-in screens so filter
// values match coach_teams rows regardless of "Little " prefix or aliases.
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

interface CoachSectionProps {
  coaches: Coach[];
  coachTeams: CoachTeam[];
  /** The filter values currently active on the parent screen. */
  filters: {
    club: string | null;
    ageGroup: string | null;
    division: string | null;
    teamName?: string | null;
  };
  onCoachPress: (coach: Coach) => void;
}

/**
 * Renders coaches whose coach_teams rows match the active filters.
 * A coach assigned to multiple teams shows up under any matching team.
 * If NO filters are active, nothing is rendered (coaches require context).
 */
function CoachSection({ coaches, coachTeams, filters, onCoachPress }: CoachSectionProps) {
  const hasActiveFilters =
    !!filters.club || !!filters.ageGroup || !!filters.division || !!filters.teamName;

  const filteredCoaches = useMemo(() => {
    if (!hasActiveFilters) return [];

    const safeCoachTeams = Array.isArray(coachTeams) ? coachTeams : [];
    const safeCoaches = Array.isArray(coaches) ? coaches : [];

    const normalizeStr = (v: string | null | undefined) =>
      (v || '').toString().trim().toLowerCase();

    // Apply the same canonicalClubName normalisation that ctClubKey uses
    // so that "Little Brighton" in the filter matches "Brighton" in coach_teams.
    const targetClub = canonicalClubName(filters.club).toLowerCase();
    const targetAge = normalizeAgeGroup(filters.ageGroup);
    const targetDivision = normalizeStr(filters.division);

    // Normalize coach_teams club the same way the roster screen does so
    // "Little Brighton" in the filter matches "Brighton" in coach_teams.
    function ctClubKey(club: string): string {
      return canonicalClubName(club).toLowerCase();
    }

    // Find which coach_teams rows match all active filters.
    const matchingCoachIds = new Set<string>();
    for (const ct of safeCoachTeams) {
      if (targetClub && ctClubKey(ct.club) !== targetClub) continue;
      if (targetAge && normalizeAgeGroup(ct.ageGroup) !== targetAge) continue;
      if (targetDivision && normalizeStr(ct.division) !== targetDivision) continue;
      if (filters.teamName) {
        const teamTarget = normalizeStr(filters.teamName);
        if (normalizeStr(ct.teamName) !== teamTarget) continue;
      }
      matchingCoachIds.add(ct.coachId);
    }

    // Return matching coaches sorted by name.
    return safeCoaches
      .filter((c) => matchingCoachIds.has(c.id))
      .sort((a, b) =>
        `${a.lastName} ${a.firstName}`.localeCompare(
          `${b.lastName} ${b.firstName}`,
        ),
      );
  }, [coaches, coachTeams, filters, hasActiveFilters]);

  if (filteredCoaches.length === 0) return null;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Users size={16} color={Colors.primary} />
        <Text style={styles.headerText}>Coaches</Text>
        <View style={styles.countBadge}>
          <Text style={styles.countText}>{filteredCoaches.length}</Text>
        </View>
      </View>

      {filteredCoaches.map((coach) => (
        <CoachCard
          key={coach.id}
          coach={coach}
          onPress={onCoachPress}
        />
      ))}
    </View>
  );
}

export default React.memo(CoachSection);

const styles = StyleSheet.create({
  container: {
    marginBottom: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    paddingHorizontal: 2,
    gap: 6,
  },
  headerText: {
    fontSize: 14,
    fontWeight: '700' as const,
    color: Colors.primary,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.8,
  },
  countBadge: {
    backgroundColor: Colors.primaryLight,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  countText: {
    fontSize: 11,
    fontWeight: '600' as const,
    color: Colors.primary,
  },
});
