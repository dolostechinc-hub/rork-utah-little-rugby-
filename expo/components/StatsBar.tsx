import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Users, CheckCircle2, Clock } from 'lucide-react-native';
import Colors from '@/constants/colors';

interface StatsBarProps {
  total: number;
  checkedIn: number;
  pending: number;
}

export default function StatsBar({ total, checkedIn, pending }: StatsBarProps) {
  const percentage = total > 0 ? Math.round((checkedIn / total) * 100) : 0;

  return (
    <View style={styles.container}>
      <View style={styles.progressContainer}>
        <View style={styles.progressBar}>
          <View style={[styles.progressFill, { width: `${percentage}%` }]} />
        </View>
        <Text style={styles.progressText}>{percentage}% Complete</Text>
      </View>

      <View style={styles.statsRow}>
        <View style={styles.stat}>
          <View style={[styles.iconBg, { backgroundColor: Colors.primaryLight }]}>
            <Users size={16} color={Colors.primary} />
          </View>
          <View>
            <Text style={styles.statValue}>{total}</Text>
            <Text style={styles.statLabel}>Total</Text>
          </View>
        </View>

        <View style={styles.stat}>
          <View style={[styles.iconBg, { backgroundColor: Colors.successLight }]}>
            <CheckCircle2 size={16} color={Colors.success} />
          </View>
          <View>
            <Text style={styles.statValue}>{checkedIn}</Text>
            <Text style={styles.statLabel}>Checked In</Text>
          </View>
        </View>

        <View style={styles.stat}>
          <View style={[styles.iconBg, { backgroundColor: Colors.warningLight }]}>
            <Clock size={16} color={Colors.warning} />
          </View>
          <View>
            <Text style={styles.statValue}>{pending}</Text>
            <Text style={styles.statLabel}>Pending</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  progressContainer: {
    marginBottom: 16,
  },
  progressBar: {
    height: 8,
    backgroundColor: Colors.surfaceAlt,
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 6,
  },
  progressFill: {
    height: '100%',
    backgroundColor: Colors.primary,
    borderRadius: 4,
  },
  progressText: {
    fontSize: 12,
    color: Colors.textSecondary,
    textAlign: 'right',
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  stat: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconBg: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  statValue: {
    fontSize: 18,
    fontWeight: '700' as const,
    color: Colors.text,
  },
  statLabel: {
    fontSize: 11,
    color: Colors.textSecondary,
    marginTop: -2,
  },
});
