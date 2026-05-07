import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  Platform,
  Switch,
} from 'react-native';
import { AlertTriangle, Coins, ArrowUp, Users, X, Shield } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import Colors from '@/constants/colors';
import { RestrictionStatus } from '@/types';
import { getNextAgeGroup } from '@/utils/playerUtils';

interface WeightRestrictionModalProps {
  visible: boolean;
  onClose: () => void;
  // Picks a contact / weight rule. The legacy 'play_up' enum value used
  // to live here too; it now lives on the orthogonal `playsUp` toggle
  // below.
  onSelect: (status: RestrictionStatus) => void;
  // Current play-up election. Editable from the toggle.
  playsUp: boolean;
  onPlaysUpChange: (next: boolean) => void;
  playerName: string;
  currentWeight: number;
  weightLimit: number;
  currentAgeGroup: string;
  // 'overweight' = the modal was forced open because the kid weighed in
  // above the U-bracket limit. The volunteer must pick a non-'none'
  // contact rule (or play up to a heavier bracket) to proceed.
  // 'voluntary' = the modal was opened by a coach to electively place
  // a kid in play-up, open division, or pennie regardless of weight.
  // The coach can also clear everything back to default.
  mode?: 'overweight' | 'voluntary';
}

export default function WeightRestrictionModal({
  visible,
  onClose,
  onSelect,
  playsUp,
  onPlaysUpChange,
  playerName,
  currentWeight,
  weightLimit,
  currentAgeGroup,
  mode = 'overweight',
}: WeightRestrictionModalProps) {
  const nextAgeGroup = getNextAgeGroup(currentAgeGroup);
  const overweightBy = currentWeight - weightLimit;
  const isVoluntary = mode === 'voluntary';

  const handleSelect = (status: RestrictionStatus) => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    onSelect(status);
  };

  const handlePlaysUpToggle = (next: boolean) => {
    if (Platform.OS !== 'web') {
      Haptics.selectionAsync();
    }
    onPlaysUpChange(next);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => {}}
    >
      <View style={styles.overlay}>
        <View style={styles.modal}>
          {isVoluntary && (
            <TouchableOpacity
              style={styles.closeBtn}
              onPress={onClose}
              activeOpacity={0.7}
              testID="restriction-modal-close"
            >
              <X size={20} color={Colors.textSecondary} />
            </TouchableOpacity>
          )}

          <View style={styles.header}>
            <View
              style={[
                styles.iconContainer,
                isVoluntary && { backgroundColor: Colors.primaryLight },
              ]}
            >
              {isVoluntary ? (
                <Shield size={32} color={Colors.primary} />
              ) : (
                <AlertTriangle size={32} color={Colors.warning} />
              )}
            </View>
            <Text style={styles.title}>
              {isVoluntary ? 'Special Placement' : 'Weight Restriction'}
            </Text>
            <Text style={styles.subtitle}>{playerName}</Text>
            {isVoluntary ? (
              <Text style={styles.helpText}>
                Choose any combination of age bracket and contact rule.
              </Text>
            ) : (
              <>
                <Text style={styles.subtitle}>weighs {currentWeight} lbs</Text>
                <Text style={styles.warningText}>
                  {overweightBy} lbs over the {weightLimit} lb limit for {currentAgeGroup} Restricted
                </Text>
              </>
            )}
          </View>

          {/* Play-up toggle. Always visible -- even in overweight mode,
             playing up to a heavier bracket is one valid resolution
             that volunteers should be able to elect on the spot. */}
          {nextAgeGroup ? (
            <View style={styles.toggleRow}>
              <View style={[styles.toggleIcon, { backgroundColor: '#EDE9FE' }]}>
                <ArrowUp size={20} color="#8B5CF6" />
              </View>
              <View style={styles.toggleContent}>
                <Text style={styles.toggleTitle}>Play Up to {nextAgeGroup}</Text>
                <Text style={styles.toggleDescription}>
                  Move this player up an age bracket. Independent of weight rule.
                </Text>
              </View>
              <Switch
                value={playsUp}
                onValueChange={handlePlaysUpToggle}
                trackColor={{ false: Colors.border, true: '#8B5CF6' }}
                thumbColor={Platform.OS === 'android' ? Colors.white : undefined}
                testID="restriction-modal-plays-up-toggle"
              />
            </View>
          ) : null}

          <Text style={styles.optionsLabel}>
            {isVoluntary ? 'Contact / weight rule:' : 'Contact / weight rule (required):'}
          </Text>

          <View style={styles.options}>
            <TouchableOpacity
              style={styles.optionCard}
              onPress={() => handleSelect('penny_player')}
              activeOpacity={0.7}
              testID="restriction-modal-pennie"
            >
              <View style={[styles.optionIcon, { backgroundColor: '#FEF3C7' }]}>
                <Coins size={24} color="#F59E0B" />
              </View>
              <View style={styles.optionContent}>
                <Text style={styles.optionTitle}>Pennie Player</Text>
                <Text style={styles.optionDescription}>
                  Touch only - no tackling allowed
                </Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.optionCard}
              onPress={() => handleSelect('open_division')}
              activeOpacity={0.7}
              testID="restriction-modal-open"
            >
              <View style={[styles.optionIcon, { backgroundColor: '#DBEAFE' }]}>
                <Users size={24} color="#3B82F6" />
              </View>
              <View style={styles.optionContent}>
                <Text style={styles.optionTitle}>Open Division</Text>
                <Text style={styles.optionDescription}>
                  Play in Open division with no weight limit
                </Text>
              </View>
            </TouchableOpacity>

            {isVoluntary && (
              <TouchableOpacity
                style={[styles.optionCard, styles.optionCardClear]}
                onPress={() => handleSelect('none')}
                activeOpacity={0.7}
                testID="restriction-modal-clear"
              >
                <View style={[styles.optionIcon, { backgroundColor: Colors.surfaceAlt }]}>
                  <Shield size={24} color={Colors.textSecondary} />
                </View>
                <View style={styles.optionContent}>
                  <Text style={styles.optionTitle}>Standard (Restricted)</Text>
                  <Text style={styles.optionDescription}>
                    Play in their normal weight bracket with the standard rule
                  </Text>
                </View>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modal: {
    backgroundColor: Colors.surface,
    borderRadius: 20,
    padding: 24,
    width: '100%',
    maxWidth: 400,
    position: 'relative',
  },
  closeBtn: {
    position: 'absolute',
    top: 12,
    right: 12,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  helpText: {
    fontSize: 13,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginTop: 8,
    paddingHorizontal: 8,
  },
  header: {
    alignItems: 'center',
    marginBottom: 20,
  },
  iconContainer: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: Colors.warningLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: '700' as const,
    color: Colors.text,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: Colors.textSecondary,
    marginBottom: 4,
  },
  warningText: {
    fontSize: 14,
    color: Colors.warning,
    fontWeight: '600' as const,
    textAlign: 'center',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: Colors.background,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 16,
  },
  toggleIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  toggleContent: {
    flex: 1,
    paddingRight: 12,
  },
  toggleTitle: {
    fontSize: 15,
    fontWeight: '600' as const,
    color: Colors.text,
    marginBottom: 2,
  },
  toggleDescription: {
    fontSize: 12,
    color: Colors.textSecondary,
  },
  optionsLabel: {
    fontSize: 14,
    fontWeight: '600' as const,
    color: Colors.textSecondary,
    marginBottom: 12,
  },
  options: {
    gap: 12,
  },
  optionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.background,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  optionCardClear: {
    borderColor: Colors.borderLight,
    backgroundColor: Colors.surfaceAlt,
  },
  optionIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  optionContent: {
    flex: 1,
  },
  optionTitle: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: Colors.text,
    marginBottom: 2,
  },
  optionDescription: {
    fontSize: 13,
    color: Colors.textSecondary,
  },
});
