import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  Platform,
} from 'react-native';
import { AlertTriangle, Coins, ArrowUp, Users } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import Colors from '@/constants/colors';
import { RestrictionStatus } from '@/types';
import { getNextAgeGroup } from '@/utils/playerUtils';

interface WeightRestrictionModalProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (status: RestrictionStatus) => void;
  playerName: string;
  currentWeight: number;
  weightLimit: number;
  currentAgeGroup: string;
}

export default function WeightRestrictionModal({
  visible,
  onClose,
  onSelect,
  playerName,
  currentWeight,
  weightLimit,
  currentAgeGroup,
}: WeightRestrictionModalProps) {
  const nextAgeGroup = getNextAgeGroup(currentAgeGroup);
  const overweightBy = currentWeight - weightLimit;

  const handleSelect = (status: RestrictionStatus) => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    onSelect(status);
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
          <View style={styles.header}>
            <View style={styles.iconContainer}>
              <AlertTriangle size={32} color={Colors.warning} />
            </View>
            <Text style={styles.title}>Weight Restriction</Text>
            <Text style={styles.subtitle}>
              {playerName} weighs {currentWeight} lbs
            </Text>
            <Text style={styles.warningText}>
              {overweightBy} lbs over the {weightLimit} lb limit for {currentAgeGroup} Restricted
            </Text>
          </View>

          <Text style={styles.optionsLabel}>You must select one option to proceed:</Text>

          <View style={styles.options}>
            <TouchableOpacity
              style={styles.optionCard}
              onPress={() => handleSelect('penny_player')}
              activeOpacity={0.7}
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

            {nextAgeGroup && (
              <TouchableOpacity
                style={styles.optionCard}
                onPress={() => handleSelect('play_up')}
                activeOpacity={0.7}
              >
                <View style={[styles.optionIcon, { backgroundColor: '#EDE9FE' }]}>
                  <ArrowUp size={24} color="#8B5CF6" />
                </View>
                <View style={styles.optionContent}>
                  <Text style={styles.optionTitle}>Play Up to {nextAgeGroup}</Text>
                  <Text style={styles.optionDescription}>
                    Move up a division with no weight restrictions
                  </Text>
                </View>
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={styles.optionCard}
              onPress={() => handleSelect('open_division')}
              activeOpacity={0.7}
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
