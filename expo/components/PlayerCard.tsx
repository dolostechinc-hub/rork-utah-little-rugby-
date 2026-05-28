import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Image } from 'react-native';
import { useRouter } from 'expo-router';
import { CheckCircle2, Circle, Camera, User, Shirt, ArrowUp } from 'lucide-react-native';
import Colors from '@/constants/colors';
import { Player, RestrictionStatus } from '@/types';
import { getRestrictionStatusLabel, getRestrictionStatusColor, isActuallyPlayingUp } from '@/utils/playerUtils';

interface PlayerCardProps {
  player: Player;
}

function PlayerCard({ player }: PlayerCardProps) {
  const router = useRouter();

  const handlePress = () => {
    console.log('Navigating to player:', player.id);
    router.push(`/player/${player.id}`);
  };

  const restrictionStatus = player.restrictionStatus as RestrictionStatus | undefined;
  const playsUp = isActuallyPlayingUp(player);

  return (
    <TouchableOpacity
      style={[styles.card, player.checkedIn && styles.cardCheckedIn]}
      onPress={handlePress}
      activeOpacity={0.7}
      testID={`player-card-${player.id}`}
    >
      <View style={styles.photoContainer}>
        {player.photoUri ? (
          <Image source={{ uri: player.photoUri }} style={styles.photo} />
        ) : (
          <View style={styles.photoPlaceholder}>
            <User size={24} color={Colors.textMuted} />
          </View>
        )}
        {player.photoUri && (
          <View style={styles.hasPhotoBadge}>
            <Camera size={10} color={Colors.white} />
          </View>
        )}
      </View>

      <View style={styles.info}>
        <View style={styles.nameRow}>
          <Text style={styles.name}>
            {player.lastName}, {player.firstName}
          </Text>
          {restrictionStatus === 'penny_player' && (
            <View style={styles.iconBadge}>
              <Shirt size={16} color="#DC2626" fill="#DC2626" fillOpacity={0.2} />
            </View>
          )}
          {playsUp && (
            <View style={styles.iconBadge}>
              <ArrowUp size={18} color="#2563EB" />
            </View>
          )}
        </View>
        <View style={styles.details}>
          <Text style={styles.detailText}>{player.ageGroup}</Text>
          <View style={styles.dot} />
          <Text style={styles.detailText}>{player.division}</Text>
        </View>
        {player.weight ? (
          <Text style={styles.weight}>{player.weight} lbs</Text>
        ) : null}
        {restrictionStatus && restrictionStatus !== 'none' && (
          <View style={[styles.restrictionBadge, { backgroundColor: getRestrictionStatusColor(restrictionStatus) + '20' }]}>
            <Text style={[styles.restrictionText, { color: getRestrictionStatusColor(restrictionStatus) }]}>
              {getRestrictionStatusLabel(restrictionStatus)}
            </Text>
          </View>
        )}
      </View>

      <View style={styles.statusContainer}>
        {player.checkedIn ? (
          <View style={styles.checkedInBadge}>
            <CheckCircle2 size={20} color={Colors.success} />
            <Text style={styles.checkedInText}>Verified</Text>
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

export default React.memo(PlayerCard);

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
  hasPhotoBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    backgroundColor: Colors.primary,
    borderRadius: 10,
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: Colors.surface,
  },
  info: {
    flex: 1,
    marginLeft: 14,
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
  name: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: Colors.text,
  },
  details: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  detailText: {
    fontSize: 13,
    color: Colors.textSecondary,
  },
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.textMuted,
    marginHorizontal: 6,
  },
  weight: {
    fontSize: 12,
    color: Colors.textMuted,
    marginTop: 2,
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
});
