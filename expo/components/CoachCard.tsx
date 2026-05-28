import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Image } from 'react-native';
import { CheckCircle2, Circle, Shield, ShieldCheck, User } from 'lucide-react-native';
import Colors from '@/constants/colors';
import type { Coach } from '@/types';

interface CoachCardProps {
  coach: Coach;
  onPress: (coach: Coach) => void;
}

function CoachCard({ coach, onPress }: CoachCardProps) {
  const handlePress = () => onPress(coach);

  return (
    <TouchableOpacity
      style={[styles.card, coach.checkedIn && styles.cardCheckedIn]}
      onPress={handlePress}
      activeOpacity={0.7}
    >
      <View style={styles.photoContainer}>
        {coach.photoUri ? (
          <Image source={{ uri: coach.photoUri }} style={styles.photo} />
        ) : (
          <View style={styles.photoPlaceholder}>
            <User size={24} color={Colors.textMuted} />
          </View>
        )}
      </View>

      <View style={styles.info}>
        <Text style={styles.name}>
          {coach.lastName}, {coach.firstName}
        </Text>
        <View style={styles.certRow}>
          {coach.isCertified ? (
            <>
              <ShieldCheck size={14} color={Colors.success} />
              <Text style={styles.certText}>Certified</Text>
            </>
          ) : (
            <>
              <Shield size={14} color={Colors.warning} />
              <Text style={styles.certTextNot}>Not Certified</Text>
            </>
          )}
        </View>
      </View>

      <View style={styles.statusContainer}>
        {coach.checkedIn ? (
          <View style={styles.checkedInBadge}>
            <CheckCircle2 size={20} color={Colors.success} />
            <Text style={styles.checkedInText}>Checked In</Text>
          </View>
        ) : (
          <View style={styles.pendingBadge}>
            <Circle size={20} color={Colors.textMuted} />
            <Text style={styles.pendingText}>Pending</Text>
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
}

export default React.memo(CoachCard);

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  cardCheckedIn: {
    backgroundColor: Colors.successLight,
    borderColor: Colors.success,
    opacity: 0.85,
  },
  photoContainer: {
    position: 'relative',
  },
  photo: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: Colors.surfaceAlt,
  },
  photoPlaceholder: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: Colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: {
    flex: 1,
    marginLeft: 14,
  },
  name: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: Colors.text,
    marginBottom: 4,
  },
  certRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  certText: {
    fontSize: 12,
    color: Colors.success,
    fontWeight: '500' as const,
  },
  certTextNot: {
    fontSize: 12,
    color: Colors.warning,
    fontWeight: '500' as const,
  },
  statusContainer: {
    alignItems: 'flex-end',
  },
  checkedInBadge: {
    alignItems: 'center',
  },
  checkedInText: {
    fontSize: 11,
    color: Colors.success,
    marginTop: 2,
    fontWeight: '500' as const,
  },
  pendingBadge: {
    alignItems: 'center',
  },
  pendingText: {
    fontSize: 11,
    color: Colors.textMuted,
    marginTop: 2,
  },
});
