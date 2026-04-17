import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Image,
  Alert,
  Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import {
  Camera,
  CheckCircle2,
  Circle,
  User,
  Calendar,
  Phone,
  Scale,
  ArrowLeft,
  Save,
  AlertTriangle,
} from 'lucide-react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import { useRegistration, usePlayer } from '@/contexts/RegistrationContext';
import { useAuth } from '@/contexts/AuthContext';
import { uploadPlayerPhoto } from '@/lib/supabase';
import Colors from '@/constants/colors';
import { RestrictionStatus } from '@/types';
import WeightRestrictionModal from '@/components/WeightRestrictionModal';
import {
  calculateAgeGroup,
  checkWeightRestriction,
  getRestrictionStatusLabel,
  getRestrictionStatusColor,
  getNextAgeGroup,
} from '@/utils/playerUtils';

export default function PlayerDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const player = usePlayer(id || '');
  const { updatePlayer, isUpdating } = useRegistration();
  const { canEdit } = useAuth();

  const [isAgeVerified, setIsAgeVerified] = useState(false);
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [weight, setWeight] = useState('');
  const [restrictionStatus, setRestrictionStatus] = useState<RestrictionStatus>('none');
  const [showWeightModal, setShowWeightModal] = useState(false);
  const [pendingWeight, setPendingWeight] = useState('');
  const [playUpAgeGroup, setPlayUpAgeGroup] = useState<string | null>(null);

  useEffect(() => {
    if (player) {
      setIsAgeVerified(player.isAgeVerified);
      setPhotoUri(player.photoUri);
      setWeight(player.weight);
      setRestrictionStatus((player as any).restrictionStatus || 'none');
      if ((player as any).restrictionStatus === 'play_up' && (player as any).calculatedAgeGroup) {
        setPlayUpAgeGroup(player.ageGroup);
      }
    }
  }, [player]);

  const calculatedAgeGroup = useMemo(() => {
    if (!player?.dateOfBirth) return null;
    return calculateAgeGroup(player.dateOfBirth);
  }, [player?.dateOfBirth]);

  const effectiveAgeGroup = calculatedAgeGroup || player?.ageGroup || '';

  const handleWeightChange = (newWeight: string) => {
    setWeight(newWeight);
    
    if (newWeight.trim() && player) {
      const restriction = checkWeightRestriction(
        effectiveAgeGroup,
        newWeight,
        player.division
      );
      
      if (restriction.isOverweight && restriction.limit) {
        setPendingWeight(newWeight);
        setShowWeightModal(true);
      } else {
        setRestrictionStatus('none');
      }
    }
  };

  const handleRestrictionSelect = (status: RestrictionStatus) => {
    setRestrictionStatus(status);
    setShowWeightModal(false);
    
    if (status === 'play_up') {
      const nextAgeGroup = getNextAgeGroup(effectiveAgeGroup);
      if (nextAgeGroup) {
        console.log(`Moving player from ${effectiveAgeGroup} to ${nextAgeGroup}`);
        setPlayUpAgeGroup(nextAgeGroup);
      }
    } else {
      setPlayUpAgeGroup(null);
    }
  };

  if (!player) {
    return (
      <View style={styles.notFoundContainer}>
        <Text style={styles.notFoundText}>Player not found</Text>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.backButtonText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const handleToggleVerified = () => {
    if (Platform.OS !== 'web') {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    setIsAgeVerified(!isAgeVerified);
    
  };

  const handleTakePhoto = async () => {
    const permissionResult = await ImagePicker.requestCameraPermissionsAsync();
    
    if (!permissionResult.granted) {
      Alert.alert('Permission Required', 'Camera access is needed to take photos.');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });

    if (!result.canceled && result.assets[0]) {
      setPhotoUri(result.assets[0].uri);
      
      if (Platform.OS !== 'web') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    }
  };

  const [isUploading, setIsUploading] = useState(false);
  const [isRegisteringWeight, setIsRegisteringWeight] = useState(false);
  const [weightRegistered, setWeightRegistered] = useState(false);

  const handleWeightBlur = async () => {
    if (!player) return;
    const trimmed = weight.trim();
    if (!trimmed) return;
    if (trimmed === (player.weight || '').trim()) return;
    if (showWeightModal) return;

    console.log('Registering weight for player:', player.id, 'weight:', trimmed);
    setIsRegisteringWeight(true);
    setWeightRegistered(false);
    try {
      await updatePlayer({
        ...player,
        weight: trimmed,
        restrictionStatus,
        calculatedAgeGroup: calculatedAgeGroup || undefined,
      });
      console.log('Weight registered and synced for player:', player.id);
      setWeightRegistered(true);
      if (Platform.OS !== 'web') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      setTimeout(() => setWeightRegistered(false), 2500);
    } catch (error) {
      console.error('Failed to register weight:', error);
    } finally {
      setIsRegisteringWeight(false);
    }
  };

  const handleSave = async () => {
    const missingFields: string[] = [];
    
    if (!isAgeVerified) {
      missingFields.push('Age Verification');
    }
    if (!weight.trim()) {
      missingFields.push('Weight');
    }
    if (!photoUri) {
      missingFields.push('Photo');
    }
    
    if (missingFields.length > 0) {
      Alert.alert(
        'Required Fields Missing',
        `Please complete the following before saving:\n\n• ${missingFields.join('\n• ')}`,
        [{ text: 'OK' }]
      );
      return;
    }
    
    console.log('Saving player check-in:', player.id);
    
    let finalPhotoUri = photoUri;
    
    if (photoUri && !photoUri.startsWith('http')) {
      console.log('Uploading photo to cloud storage...');
      setIsUploading(true);
      try {
        const uploadedUrl = await uploadPlayerPhoto(player.id, photoUri, 'utah-little-rugby');
        if (uploadedUrl) {
          console.log('Photo uploaded to cloud successfully:', uploadedUrl);
          finalPhotoUri = uploadedUrl;
          setPhotoUri(uploadedUrl);
        } else {
          console.error('Photo cloud upload returned null');
          setIsUploading(false);
          Alert.alert(
            'Photo Upload Failed',
            'Could not upload the photo to cloud storage. Photos must be stored in the cloud so all devices can access them. Please check your internet connection and try again.',
            [{ text: 'OK' }]
          );
          return;
        }
      } catch (uploadError) {
        console.error('Photo cloud upload error:', uploadError);
        setIsUploading(false);
        Alert.alert(
          'Photo Upload Failed',
          'Could not upload the photo to cloud storage. Please check your internet connection and try again.',
          [{ text: 'OK' }]
        );
        return;
      }
      setIsUploading(false);
    }
    
    const checkedIn = true;
    
    const finalAgeGroup = playUpAgeGroup || calculatedAgeGroup || player.ageGroup;
    
    try {
      await updatePlayer({
        ...player,
        isAgeVerified,
        photoUri: finalPhotoUri,
        weight,
        checkedIn,
        checkedInAt: new Date().toISOString(),
        restrictionStatus,
        ageGroup: finalAgeGroup,
        calculatedAgeGroup: calculatedAgeGroup || undefined,
      });

      console.log('Player check-in saved and synced successfully');

      if (Platform.OS !== 'web') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }

      Alert.alert(
        'Check-In Complete',
        `${player.firstName} ${player.lastName} has been verified and checked in. Data synced to Google Sheets.`,
        [{ text: 'OK', onPress: () => router.back() }]
      );
    } catch (error) {
      console.error('Failed to save player check-in:', error);
      Alert.alert(
        'Sync Failed',
        'The check-in data could not be synced to Google Sheets. Please check your connection and try again.',
        [{ text: 'OK' }]
      );
    }
  };

  const isComplete = isAgeVerified && photoUri !== null && weight.trim() !== '';

  return (
    <>
      <Stack.Screen
        options={{
          title: `${player.firstName} ${player.lastName}`,
          headerLeft: () => (
            <TouchableOpacity onPress={() => router.back()} style={styles.headerButton}>
              <ArrowLeft size={24} color={Colors.primary} />
            </TouchableOpacity>
          ),
        }}
      />

      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <View style={styles.photoSection}>
          <TouchableOpacity
            style={[
              styles.photoContainer,
              !photoUri && styles.photoRequired,
            ]}
            onPress={canEdit ? handleTakePhoto : undefined}
            activeOpacity={canEdit ? 0.8 : 1}
            disabled={!canEdit}
          >
            {photoUri ? (
              <Image source={{ uri: photoUri }} style={styles.photo} />
            ) : (
              <View style={styles.photoPlaceholder}>
                <User size={48} color={Colors.textMuted} />
                <Text style={styles.photoRequiredText}>Photo Required</Text>
              </View>
            )}
            <View style={[styles.cameraButton, !photoUri && styles.cameraButtonRequired]}>
              <Camera size={20} color={Colors.white} />
            </View>
          </TouchableOpacity>
          {!photoUri && (
            <Text style={styles.photoHint}>Tap to take a photo for check-in</Text>
          )}

          <Text style={styles.playerName}>
            {player.firstName} {player.lastName}
          </Text>

          <View style={styles.badges}>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{player.club}</Text>
            </View>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>
                {playUpAgeGroup || calculatedAgeGroup || player.ageGroup}
                {playUpAgeGroup && ' ↑'}
              </Text>
            </View>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{player.division}</Text>
            </View>
          </View>
          {calculatedAgeGroup && calculatedAgeGroup !== player.ageGroup && !playUpAgeGroup && (
            <View style={styles.ageGroupNote}>
              <Text style={styles.ageGroupNoteText}>
                Auto-assigned from DOB (was: {player.ageGroup})
              </Text>
            </View>
          )}
          {playUpAgeGroup && (
            <View style={[styles.ageGroupNote, { backgroundColor: '#EDE9FE' }]}>
              <Text style={[styles.ageGroupNoteText, { color: '#8B5CF6' }]}>
                Playing up from {effectiveAgeGroup} to {playUpAgeGroup}
              </Text>
            </View>
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Player Details</Text>

          <View style={styles.detailRow}>
            <Calendar size={18} color={Colors.textSecondary} />
            <Text style={styles.detailLabel}>Date of Birth</Text>
            {canEdit ? (
              <Text style={styles.detailValue}>{player.dateOfBirth || 'Not provided'}</Text>
            ) : (
              <Text style={styles.obfuscatedValue}>••••••••••</Text>
            )}
          </View>

          <View style={styles.detailRow}>
            <User size={18} color={Colors.textSecondary} />
            <Text style={styles.detailLabel}>Parent/Guardian</Text>
            {canEdit ? (
              <Text style={styles.detailValue}>{player.parentName || 'Not provided'}</Text>
            ) : (
              <Text style={styles.obfuscatedValue}>••••••••••</Text>
            )}
          </View>

          <View style={styles.detailRow}>
            <Phone size={18} color={Colors.textSecondary} />
            <Text style={styles.detailLabel}>Phone</Text>
            {canEdit ? (
              <Text style={styles.detailValue}>{player.parentPhone || 'Not provided'}</Text>
            ) : (
              <Text style={styles.obfuscatedValue}>••••••••••</Text>
            )}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Check-In Verification</Text>

          <TouchableOpacity
            style={[styles.verificationCard, isAgeVerified && styles.verificationCardActive, !canEdit && styles.disabledCard]}
            onPress={canEdit ? handleToggleVerified : undefined}
            activeOpacity={canEdit ? 0.7 : 1}
            disabled={!canEdit}
          >
            {isAgeVerified ? (
              <CheckCircle2 size={28} color={Colors.success} />
            ) : (
              <Circle size={28} color={Colors.textMuted} />
            )}
            <View style={styles.verificationContent}>
              <Text style={styles.verificationTitle}>Age Verified</Text>
              <Text style={styles.verificationSubtitle}>
                {isAgeVerified ? 'Birth certificate or ID confirmed' : 'Tap to confirm age verification'}
              </Text>
            </View>
          </TouchableOpacity>

          <View style={[styles.weightCard, !canEdit && styles.disabledCard]}>
            <Scale size={22} color={Colors.textSecondary} />
            <View style={styles.weightContent}>
              <Text style={styles.weightLabel}>Weight (lbs)</Text>
              <TextInput
                style={styles.weightInput}
                value={weight}
                onChangeText={handleWeightChange}
                onBlur={handleWeightBlur}
                placeholder="Enter weight"
                placeholderTextColor={Colors.textMuted}
                keyboardType="numeric"
                editable={canEdit}
                testID="player-weight-input"
              />
              {isRegisteringWeight && (
                <Text style={styles.weightStatusText}>Saving…</Text>
              )}
              {!isRegisteringWeight && weightRegistered && (
                <Text style={[styles.weightStatusText, { color: Colors.success }]}>Saved</Text>
              )}
            </View>
          </View>

          {restrictionStatus && restrictionStatus !== 'none' && (
            <View style={[styles.restrictionCard, { borderColor: getRestrictionStatusColor(restrictionStatus) }]}>
              <AlertTriangle size={20} color={getRestrictionStatusColor(restrictionStatus)} />
              <View style={styles.restrictionContent}>
                <Text style={[styles.restrictionTitle, { color: getRestrictionStatusColor(restrictionStatus) }]}>
                  {getRestrictionStatusLabel(restrictionStatus)}
                </Text>
                <Text style={styles.restrictionSubtitle}>
                  Player is over weight limit for restricted division
                </Text>
              </View>
            </View>
          )}
        </View>

        <View style={styles.statusSection}>
          <View style={[styles.statusBanner, isComplete ? styles.statusComplete : styles.statusIncomplete]}>
            {isComplete ? (
              <CheckCircle2 size={24} color={Colors.success} />
            ) : (
              <Circle size={24} color={Colors.warning} />
            )}
            <Text style={[styles.statusText, isComplete ? styles.statusTextComplete : styles.statusTextIncomplete]}>
              {isComplete ? 'Ready to Check In' : 'Verification Incomplete'}
            </Text>
          </View>
          <Text style={styles.statusHint}>
            {(() => {
              const missing: string[] = [];
              if (!isAgeVerified) missing.push('age verification');
              if (!weight.trim()) missing.push('weight');
              if (!photoUri) missing.push('photo');
              if (missing.length === 0) return 'All requirements met';
              return `Required: ${missing.join(', ')}`;
            })()}
          </Text>
        </View>

        {canEdit ? (
          <TouchableOpacity
            style={[styles.saveButton, isComplete && styles.saveButtonComplete]}
            onPress={handleSave}
            disabled={isUpdating || isUploading}
            activeOpacity={0.8}
          >
            <Save size={22} color={Colors.white} />
            <Text style={styles.saveButtonText}>
              {isUploading ? 'Uploading Photo...' : isUpdating ? 'Syncing...' : isComplete ? 'Complete Check-In' : 'Complete Required Fields'}
            </Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.viewOnlyBanner}>
            <Text style={styles.viewOnlyText}>View-Only Mode</Text>
            <Text style={styles.viewOnlySubtext}>Go to Settings to unlock admin access</Text>
          </View>
        )}
      </ScrollView>

      {player && (
        <WeightRestrictionModal
          visible={showWeightModal}
          onClose={() => setShowWeightModal(false)}
          onSelect={handleRestrictionSelect}
          playerName={`${player.firstName} ${player.lastName}`}
          currentWeight={parseFloat(pendingWeight) || 0}
          weightLimit={checkWeightRestriction(effectiveAgeGroup, pendingWeight, player.division).limit || 0}
          currentAgeGroup={effectiveAgeGroup}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  content: {
    padding: 20,
    paddingBottom: 40,
  },
  notFoundContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.background,
  },
  notFoundText: {
    fontSize: 18,
    color: Colors.textSecondary,
    marginBottom: 16,
  },
  backButton: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: Colors.primary,
    borderRadius: 8,
  },
  backButtonText: {
    color: Colors.white,
    fontWeight: '600' as const,
  },
  headerButton: {
    padding: 4,
  },
  photoSection: {
    alignItems: 'center',
    marginBottom: 24,
  },
  photoContainer: {
    position: 'relative',
    marginBottom: 16,
  },
  photo: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: Colors.surfaceAlt,
  },
  photoPlaceholder: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: Colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: Colors.border,
    borderStyle: 'dashed',
  },
  photoRequired: {
    borderWidth: 0,
  },
  photoRequiredText: {
    fontSize: 10,
    color: Colors.error,
    fontWeight: '600' as const,
    marginTop: 4,
    textAlign: 'center' as const,
  },
  photoHint: {
    fontSize: 13,
    color: Colors.error,
    fontWeight: '500' as const,
    marginTop: 8,
    textAlign: 'center' as const,
  },
  cameraButton: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: Colors.white,
  },
  cameraButtonRequired: {
    backgroundColor: Colors.error,
  },
  playerName: {
    fontSize: 24,
    fontWeight: '700' as const,
    color: Colors.text,
    marginBottom: 12,
  },
  badges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
  },
  badge: {
    backgroundColor: Colors.primaryLight,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  badgeText: {
    fontSize: 13,
    fontWeight: '500' as const,
    color: Colors.primary,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: Colors.text,
    marginBottom: 12,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    padding: 14,
    borderRadius: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  detailLabel: {
    flex: 1,
    fontSize: 14,
    color: Colors.textSecondary,
    marginLeft: 12,
  },
  detailValue: {
    fontSize: 14,
    fontWeight: '500' as const,
    color: Colors.text,
  },
  obfuscatedValue: {
    fontSize: 14,
    fontWeight: '500' as const,
    color: Colors.textMuted,
    letterSpacing: 2,
  },
  verificationCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    padding: 16,
    borderRadius: 14,
    marginBottom: 12,
    borderWidth: 2,
    borderColor: Colors.border,
  },
  verificationCardActive: {
    borderColor: Colors.success,
    backgroundColor: Colors.successLight,
  },
  verificationContent: {
    flex: 1,
    marginLeft: 14,
  },
  verificationTitle: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: Colors.text,
    marginBottom: 2,
  },
  verificationSubtitle: {
    fontSize: 13,
    color: Colors.textSecondary,
  },
  weightCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  weightContent: {
    flex: 1,
    marginLeft: 14,
  },
  weightLabel: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginBottom: 4,
  },
  weightStatusText: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: 4,
    fontWeight: '600' as const,
  },
  weightInput: {
    fontSize: 18,
    fontWeight: '600' as const,
    color: Colors.text,
    padding: 0,
  },
  statusSection: {
    marginBottom: 24,
  },
  statusBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    borderRadius: 12,
    marginBottom: 8,
  },
  statusComplete: {
    backgroundColor: Colors.successLight,
  },
  statusIncomplete: {
    backgroundColor: Colors.warningLight,
  },
  statusText: {
    fontSize: 16,
    fontWeight: '600' as const,
    marginLeft: 10,
  },
  statusTextComplete: {
    color: Colors.success,
  },
  statusTextIncomplete: {
    color: Colors.warning,
  },
  statusHint: {
    fontSize: 13,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  saveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.textSecondary,
    borderRadius: 14,
    paddingVertical: 16,
    gap: 10,
  },
  saveButtonComplete: {
    backgroundColor: Colors.primary,
  },
  saveButtonText: {
    fontSize: 18,
    fontWeight: '600' as const,
    color: Colors.white,
  },
  disabledCard: {
    opacity: 0.6,
  },
  viewOnlyBanner: {
    backgroundColor: Colors.surfaceAlt,
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 20,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  viewOnlyText: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: Colors.textSecondary,
    marginBottom: 4,
  },
  viewOnlySubtext: {
    fontSize: 13,
    color: Colors.textMuted,
  },
  ageGroupNote: {
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 4,
    backgroundColor: Colors.warningLight,
    borderRadius: 8,
  },
  ageGroupNoteText: {
    fontSize: 12,
    color: Colors.warning,
    fontWeight: '500' as const,
  },
  restrictionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    padding: 16,
    borderRadius: 14,
    marginTop: 12,
    borderWidth: 2,
  },
  restrictionContent: {
    flex: 1,
    marginLeft: 14,
  },
  restrictionTitle: {
    fontSize: 15,
    fontWeight: '600' as const,
    marginBottom: 2,
  },
  restrictionSubtitle: {
    fontSize: 12,
    color: Colors.textSecondary,
  },
});
