import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
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
  KeyboardAvoidingView,
  Keyboard,
  Modal,
  Pressable,
  StatusBar,
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import {
  Camera,
  CheckCircle2,
  Circle,
  User,
  Calendar,
  Scale,
  ArrowLeft,
  Save,
  AlertTriangle,
  Users,
  ChevronRight,
  RotateCcw,
  Shield,
  Building2,
  X,
} from 'lucide-react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import { useRegistration, usePlayer } from '@/contexts/RegistrationContext';
import { useAuth } from '@/contexts/AuthContext';
import Colors from '@/constants/colors';
import { RestrictionStatus } from '@/types';
import WeightRestrictionModal from '@/components/WeightRestrictionModal';
import TeamAssignmentModal from '@/components/TeamAssignmentModal';
import ClubPickerModal from '@/components/ClubPickerModal';
import { formatTeamAssignments } from '@/utils/teamAssignments';
import {
  ageGroupRank,
  calculateAgeGroup,
  checkWeightRestriction,
  getRestrictionStatusLabel,
  getRestrictionStatusColor,
  getNextAgeGroup,
  isActuallyPlayingUp,
} from '@/utils/playerUtils';

export default function PlayerDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const player = usePlayer(id || '');
  const {
    updatePlayer,
    isUpdating,
    teams,
    clubs,
    ageGroups,
    isPreviouslyAgeVerified,
    showTeamAssignment,
    enqueuePhotoUpload,
    flushPhotoQueueNow,
  } = useRegistration();
  const { canEdit, isAdmin } = useAuth();

  const scrollRef = useRef<ScrollView | null>(null);
  const weightInputRef = useRef<TextInput | null>(null);
  const initializedForIdRef = useRef<string | null>(null);
  const [isAgeVerified, setIsAgeVerified] = useState(false);
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [weight, setWeight] = useState('');
  const [restrictionStatus, setRestrictionStatus] = useState<RestrictionStatus>('none');
  const [playsUp, setPlaysUp] = useState<boolean>(false);
  const [showWeightModal, setShowWeightModal] = useState(false);
  const [pendingWeight, setPendingWeight] = useState('');
  // Distinguishes "kid weighed in over the limit, must pick a placement
  // to proceed" from "coach voluntarily placing a kid in an alternate
  // bracket". Voluntary mode shows a close button and a Standard/None
  // option so coaches can also clear the restriction.
  const [restrictionModalMode, setRestrictionModalMode] = useState<'overweight' | 'voluntary'>('overweight');
  const [playUpAgeGroup, setPlayUpAgeGroup] = useState<string | null>(null);
  const [isSavingAgeGroup, setIsSavingAgeGroup] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isRegisteringWeight, setIsRegisteringWeight] = useState(false);
  const [weightRegistered, setWeightRegistered] = useState(false);
  const [showTeamModal, setShowTeamModal] = useState(false);
  const [isSavingTeam, setIsSavingTeam] = useState(false);
  const [isUncheckingIn, setIsUncheckingIn] = useState(false);
  const [showClubModal, setShowClubModal] = useState(false);
  const [isSavingClub, setIsSavingClub] = useState(false);
  const [isPhotoExpanded, setIsPhotoExpanded] = useState(false);

  const handleUncheckIn = () => {
    if (!player) return;
    if (Platform.OS !== 'web') {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    Alert.alert(
      'Undo Check-In?',
      `This will un-check-in ${player.firstName} ${player.lastName}. The player will need to be checked in again. Are you sure you selected the wrong child?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Undo Check-In',
          style: 'destructive',
          onPress: async () => {
            setIsUncheckingIn(true);
            try {
              console.log('Un-checking in player:', player.id);
              await updatePlayer({
                ...player,
                checkedIn: false,
                checkedInAt: null,
              });
              if (Platform.OS !== 'web') {
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              }
              Alert.alert(
                'Check-In Undone',
                `${player.firstName} ${player.lastName} has been un-checked in and will need to be checked in again.`,
                [{ text: 'OK', onPress: () => router.back() }]
              );
            } catch (error) {
              console.error('Failed to un-check in player:', error);
              Alert.alert('Could Not Undo', 'Please try again.');
            } finally {
              setIsUncheckingIn(false);
            }
          },
        },
      ]
    );
  };

  useEffect(() => {
    if (!player) return;
    // Only seed local state the first time we see this player. Subsequent
    // updates to the player record (e.g. after saving weight) must not wipe
    // out in-progress local edits like photo or age verification toggle.
    if (initializedForIdRef.current === player.id) return;
    initializedForIdRef.current = player.id;
    // registry hit is used below when seeding isAgeVerified

    const registryVerified = isPreviouslyAgeVerified(
      player.firstName,
      player.lastName,
      player.dateOfBirth
    );
    setIsAgeVerified(!!player.isAgeVerified || registryVerified);
    setPhotoUri(player.photoUri ?? null);
    setWeight(player.weight ?? '');
    // Migration 046 split play-up out of restriction_status. Older
    // local cache rows may still carry the legacy 'play_up' enum value
    // until the next cloud round-trip rewrites them, so map both:
    //   - if `playsUp` is set, trust it
    //   - else if restrictionStatus is the legacy 'play_up', treat as
    //     plays_up=true with restrictionStatus normalized to 'none'
    const rawRestriction = (player as { restrictionStatus?: string }).restrictionStatus ?? 'none';
    const isLegacyPlayUp = rawRestriction === 'play_up';
    setRestrictionStatus(
      isLegacyPlayUp ? 'none' : ((rawRestriction as RestrictionStatus) || 'none'),
    );
    setPlaysUp(player.playsUp ?? isLegacyPlayUp);

    // Only treat as playing up when the rostered age group is strictly
    // higher than the DOB-calculated age group.  A bare `playsUp` flag
    // with matching ranks (e.g. both U14) is a no-op and must not show
    // the "Playing Up" banner or ↑ badge.
    const actuallyPlayingUp =
      (player.playsUp || isLegacyPlayUp) &&
      isActuallyPlayingUp({
        playsUp: player.playsUp ?? isLegacyPlayUp,
        ageGroup: player.ageGroup,
        calculatedAgeGroup: calculateAgeGroup(player.dateOfBirth) ?? player.calculatedAgeGroup ?? null,
      });
    setPlaysUp(actuallyPlayingUp);
    setPlayUpAgeGroup(actuallyPlayingUp ? player.ageGroup : null);
  }, [player]);

  const calculatedAgeGroup = useMemo(() => {
    if (!player?.dateOfBirth) return null;
    return calculateAgeGroup(player.dateOfBirth);
  }, [player?.dateOfBirth]);

  // `ageGroup` is the intentional roster placement and must win over the
  // DOB-derived `calculatedAgeGroup` so admin waivers/play-down overrides
  // made in the app or directly in Supabase do not get overwritten on save.
  const effectiveAgeGroup = player?.ageGroup || calculatedAgeGroup || '';

  const handleWeightChange = (newWeight: string) => {
    setWeight(newWeight);

    if (newWeight.trim() && player) {
      const restriction = checkWeightRestriction(
        effectiveAgeGroup,
        newWeight,
        player.division
      );

      // Only force the modal open when a kid is over the weight limit.
      // We deliberately do NOT clear the existing restriction when the
      // weight is under the limit -- coaches can voluntarily place a
      // player in play_up, open_division, or pennie regardless of
      // weight, and updating the weight should never silently undo
      // that election. Clearing back to 'none' is a deliberate action
      // taken from the Special Placement card below.
      if (restriction.isOverweight && restriction.limit && !playsUp && restrictionStatus === 'none') {
        setPendingWeight(newWeight);
        setRestrictionModalMode('overweight');
        setShowWeightModal(true);
      }
    }
  };

  const handleRestrictionSelect = (status: RestrictionStatus) => {
    setRestrictionStatus(status);
    setShowWeightModal(false);

    // When a coach voluntarily changes the restriction (Special Placement),
    // auto-save so they don't lose the change.  The overweight path already
    // saves through handleWeightBlur when the weight input loses focus.
    if (restrictionModalMode === 'voluntary' && player) {
      const finalAgeGroup = playsUp && playUpAgeGroup ? playUpAgeGroup : player.ageGroup;
      void updatePlayer({
        ...player,
        isAgeVerified,
        photoUri: photoUri ?? player.photoUri,
        weight: (weight.trim() || player.weight || ''),
        restrictionStatus: status,
        playsUp,
        ageGroup: finalAgeGroup || player.ageGroup,
        calculatedAgeGroup: calculatedAgeGroup || undefined,
      }).catch((err) => {
        console.warn('[player] auto-save restriction failed:', err);
      });
    }
  };

  const handlePlaysUpChange = (next: boolean) => {
    setPlaysUp(next);
    if (next) {
      const nextAgeGroup = getNextAgeGroup(effectiveAgeGroup);
      if (nextAgeGroup) {
        console.log(`Moving player from ${effectiveAgeGroup} to ${nextAgeGroup}`);
        setPlayUpAgeGroup(nextAgeGroup);
        // Playing up resolves the restricted-weight popup by moving the kid
        // into the next age bracket. It is not a contact restriction, so keep
        // restriction_status='none' and close the forced overweight prompt.
        setRestrictionStatus('none');
        if (restrictionModalMode === 'overweight') {
          setShowWeightModal(false);
        }
      }
    } else {
      setPlayUpAgeGroup(null);
    }
  };

  const handleOpenVoluntaryRestriction = useCallback(() => {
    if (!canEdit || !player) return;
    setPendingWeight((weight.trim() || player.weight || '').toString());
    setRestrictionModalMode('voluntary');
    setShowWeightModal(true);
  }, [canEdit, player, weight]);

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
    try {
      const permissionResult = await ImagePicker.requestCameraPermissionsAsync();

      if (!permissionResult.granted) {
        Alert.alert('Permission Required', 'Camera access is needed to take photos.');
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        allowsEditing: Platform.OS === 'ios',
        aspect: [1, 1],
        quality: 0.85,
        exif: false,
      });

      if (!result.canceled && result.assets && result.assets[0]) {
        const asset = result.assets[0];
        console.log('[player] photo captured', {
          uri: asset.uri,
          width: asset.width,
          height: asset.height,
          mimeType: asset.mimeType,
          fileSize: asset.fileSize,
          platform: Platform.OS,
        });
        setPhotoUri(asset.uri);

        if (Platform.OS !== 'web') {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[player] camera error:', err);
      Alert.alert('Camera error', message);
    }
  };

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
        // Preserve any in-progress local edits so saving the weight does not
        // wipe out a freshly taken photo or the age verification toggle.
        isAgeVerified,
        photoUri: photoUri ?? player.photoUri,
        weight: trimmed,
        restrictionStatus,
        playsUp,
        ageGroup: playsUp && playUpAgeGroup ? playUpAgeGroup : player.ageGroup,
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
    const trimmedWeight = weight.trim();
    const missingFields: string[] = [];

    if (!isAgeVerified) {
      missingFields.push('Age Verification');
    }
    if (!trimmedWeight) {
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

    // Audit Medium #2: never block the local save on the photo upload.
    // The volunteer needs the check-in to commit even on flaky wifi at a
    // pitch. We save the player with whatever URI the user picked (local
    // file:// or already-uploaded https://) and hand the actual upload
    // off to the photo upload queue. When the upload eventually succeeds,
    // RegistrationContext patches the player's photoUri to the cloud URL
    // and re-syncs through the regular cloud sync queue.
    const checkedIn = true;
    const finalAgeGroup = playUpAgeGroup || player.ageGroup || calculatedAgeGroup || "";
    const isLocalPhoto = !!photoUri && !photoUri.startsWith('http');

    try {
      await updatePlayer({
        ...player,
        isAgeVerified,
        photoUri,
        weight: trimmedWeight,
        checkedIn,
        checkedInAt: new Date().toISOString(),
        restrictionStatus,
        playsUp,
        ageGroup: finalAgeGroup,
        calculatedAgeGroup: calculatedAgeGroup || undefined,
      });

      if (isLocalPhoto && photoUri) {
        try {
          enqueuePhotoUpload(
            player.id,
            photoUri,
            `${player.firstName ?? ''} ${player.lastName ?? ''}`.trim(),
          );
          // Fire-and-forget: try the upload right now while the network
          // is fresh; if it fails we'll retry on launch / reconnect.
          setIsUploading(true);
          void flushPhotoQueueNow().finally(() => {
            setIsUploading(false);
          });
        } catch (queueErr) {
          console.warn('Failed to enqueue photo upload (will retry on launch):', queueErr);
        }
      }

      console.log('Player check-in saved locally; photo upload queued if needed');

      if (Platform.OS !== 'web') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }

      Alert.alert(
        'Check-In Complete',
        `${player.firstName} ${player.lastName} has been verified and checked in.`,
        [{ text: 'OK', onPress: () => router.back() }]
      );
    } catch (error) {
      console.error('Failed to save player check-in:', error);
      Alert.alert(
        'Save Failed',
        'The check-in could not be saved. Please try again.',
        [{ text: 'OK' }]
      );
    }
  };

  const isComplete = isAgeVerified && photoUri !== null && weight.trim() !== '';
  const isCheckedIn = !!player?.checkedIn;

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

      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 100 : 0}
      >
        <ScrollView
          ref={scrollRef}
          style={styles.container}
          contentContainerStyle={[styles.content, { paddingBottom: 320 }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.photoSection}>
            <TouchableOpacity
              style={[
                styles.photoContainer,
                !photoUri && styles.photoRequired,
              ]}
              onPress={() => {
                if (canEdit) {
                  handleTakePhoto();
                } else if (photoUri) {
                  setIsPhotoExpanded(true);
                }
              }}
              activeOpacity={canEdit || photoUri ? 0.8 : 1}
              disabled={!canEdit && !photoUri}
            >
              {photoUri ? (
                <Image source={{ uri: photoUri }} style={styles.photo} />
              ) : (
                <View style={styles.photoPlaceholder}>
                  <User size={48} color={Colors.textMuted} />
                  <Text style={styles.photoRequiredText}>Photo Required</Text>
                </View>
              )}
              {canEdit && (
                <View style={[styles.cameraButton, !photoUri && styles.cameraButtonRequired]}>
                  <Camera size={20} color={Colors.white} />
                </View>
              )}
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
                  {playUpAgeGroup || player.ageGroup || calculatedAgeGroup}
                  {playUpAgeGroup && ' ↑'}
                </Text>
              </View>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{player.division}</Text>
              </View>
              {player.teamName ? (
                <View style={[styles.badge, styles.teamBadge]}>
                  <Users size={12} color={Colors.white} />
                  <Text style={[styles.badgeText, styles.teamBadgeText]}>{formatTeamAssignments(player.teamName)}</Text>
                </View>
              ) : (
                <View style={[styles.badge, styles.teamBadgeEmpty]}>
                  <Users size={12} color={Colors.textMuted} />
                  <Text style={[styles.badgeText, styles.teamBadgeEmptyText]}>—</Text>
                </View>
              )}
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

          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Roster Placement</Text>

            <View style={styles.detailRow}>
              <Shield size={18} color={Colors.textSecondary} />
              <Text style={styles.detailLabel}>Roster Age Group</Text>
              <Text style={styles.detailValue}>{player.ageGroup || 'Not assigned'}</Text>
            </View>

            {calculatedAgeGroup && calculatedAgeGroup !== player.ageGroup && (
              <View style={[styles.ageGroupNote, styles.ageGroupOverrideNote]}>
                <Text style={[styles.ageGroupNoteText, styles.ageGroupOverrideNoteText]}>
                  Admin override: DOB calculates as {calculatedAgeGroup}, rostered as {player.ageGroup}.
                </Text>
              </View>
            )}

            {isAdmin && (
              <View style={styles.ageOverrideCard}>
                <Text style={styles.ageOverrideTitle}>Admin Age Group Override</Text>
                <Text style={styles.ageOverrideHelp}>
                  Use for approved play-down/play-up waivers. This saves the roster age group and keeps the DOB-calculated age for reference.
                </Text>
                <View style={styles.ageOverrideChips}>
                  {ageGroups.map((group) => {
                    const isSelected = group.name === player.ageGroup;
                    return (
                      <TouchableOpacity
                        key={group.id || group.name}
                        style={[styles.ageOverrideChip, isSelected && styles.ageOverrideChipActive]}
                        disabled={isSavingAgeGroup || isSelected}
                        onPress={async () => {
                          setIsSavingAgeGroup(true);
                          try {
                            const selectedRank = ageGroupRank(group.name);
                            const calculatedRank = ageGroupRank(calculatedAgeGroup);
                            const nextPlaysUp =
                              selectedRank !== null && calculatedRank !== null
                                ? selectedRank > calculatedRank
                                : false;
                            setPlaysUp(nextPlaysUp);
                            setPlayUpAgeGroup(nextPlaysUp ? group.name : null);
                            setRestrictionStatus('none');
                            await updatePlayer({
                              ...player,
                              ageGroup: group.name,
                              playsUp: nextPlaysUp,
                              restrictionStatus: 'none',
                              calculatedAgeGroup: calculatedAgeGroup || undefined,
                            });
                            if (Platform.OS !== 'web') {
                              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                            }
                          } catch (error) {
                            console.error('Failed to save age group override:', error);
                            const message = error instanceof Error ? error.message : 'Unknown error';
                            Alert.alert('Could Not Save Age Group', message);
                          } finally {
                            setIsSavingAgeGroup(false);
                          }
                        }}
                        testID={`age-override-${group.name}`}
                      >
                        <Text style={[styles.ageOverrideChipText, isSelected && styles.ageOverrideChipTextActive]}>
                          {group.name}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                {isSavingAgeGroup && <Text style={styles.ageOverrideSaving}>Saving age group…</Text>}
              </View>
            )}
          </View>

          {isAdmin && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Club & Team</Text>

              <TouchableOpacity
                style={styles.clubCard}
                onPress={() => setShowClubModal(true)}
                activeOpacity={0.7}
                disabled={isSavingClub}
                testID="club-assignment-card"
              >
                <Building2 size={22} color={Colors.primary} />
                <View style={styles.teamCardContent}>
                  <Text style={styles.teamCardLabel}>Club</Text>
                  <Text style={styles.teamCardValue}>
                    {isSavingClub
                      ? 'Saving…'
                      : player.club || 'Not assigned — tap to select'}
                  </Text>
                </View>
                <ChevronRight size={20} color={Colors.textMuted} />
              </TouchableOpacity>

              <View style={{ height: 12 }} />

              <TouchableOpacity
                style={styles.teamCard}
                onPress={() => setShowTeamModal(true)}
                activeOpacity={0.7}
                disabled={isSavingTeam}
                testID="team-assignment-card"
              >
                <Users size={22} color={Colors.primary} />
                <View style={styles.teamCardContent}>
                  <Text style={styles.teamCardLabel}>
                    {player.teamName ? 'Assigned Teams' : 'No Teams Assigned'}
                  </Text>
                  <Text style={styles.teamCardValue}>
                    {isSavingTeam
                      ? 'Saving…'
                      : formatTeamAssignments(player.teamName) || `Tap to assign (e.g. ${player.club || 'Club'} ${player.ageGroup || 'Age'} Blue)`}
                  </Text>
                </View>
                <ChevronRight size={20} color={Colors.textMuted} />
              </TouchableOpacity>
            </View>
          )}

          {canEdit && showTeamAssignment && !isAdmin && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Team Assignment</Text>
              <TouchableOpacity
                style={styles.teamCard}
                onPress={() => setShowTeamModal(true)}
                activeOpacity={0.7}
                disabled={isSavingTeam}
                testID="team-assignment-card"
              >
                <Users size={22} color={Colors.primary} />
                <View style={styles.teamCardContent}>
                  <Text style={styles.teamCardLabel}>
                    {player.teamName ? 'Assigned Teams' : 'No Teams Assigned'}
                  </Text>
                  <Text style={styles.teamCardValue}>
                    {isSavingTeam
                      ? 'Saving…'
                      : formatTeamAssignments(player.teamName) || `Tap to assign (e.g. ${player.club} ${player.ageGroup} Blue)`}
                  </Text>
                </View>
                <ChevronRight size={20} color={Colors.textMuted} />
              </TouchableOpacity>
            </View>
          )}

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Check-In Verification</Text>

            <TouchableOpacity
              style={[
                styles.verificationCard,
                isAgeVerified && styles.verificationCardActive,
                !canEdit && styles.disabledCard,
              ]}
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
                  {isPreviouslyAgeVerified(
                    player.firstName,
                    player.lastName,
                    player.dateOfBirth
                  )
                    ? 'Verified in a previous season — no docs needed'
                    : isAgeVerified
                      ? 'Birth certificate or ID confirmed'
                      : 'Tap to confirm age verification'}
                </Text>
              </View>
            </TouchableOpacity>

            <View style={[styles.weightCard, !canEdit && styles.disabledCard]}>
              <Scale size={22} color={Colors.textSecondary} />
              <View style={styles.weightContent}>
                <Text style={styles.weightLabel}>Weight (lbs)</Text>
                <TextInput
                  ref={weightInputRef}
                  style={styles.weightInput}
                  value={weight}
                  onChangeText={handleWeightChange}
                  onBlur={handleWeightBlur}
                  onFocus={() => {
                    setTimeout(() => {
                      scrollRef.current?.scrollToEnd({ animated: true });
                    }, 250);
                  }}
                  placeholder="Enter weight"
                  placeholderTextColor={Colors.textMuted}
                  keyboardType="numeric"
                  returnKeyType="done"
                  onSubmitEditing={() => Keyboard.dismiss()}
                  editable={canEdit}
                  testID="player-weight-input"
                />
                {isRegisteringWeight && (
                  <Text style={styles.weightStatusText}>Saving…</Text>
                )}
                {!isRegisteringWeight && weightRegistered && (
                  <Text style={[styles.weightStatusText, { color: Colors.success }]}>
                    Saved
                  </Text>
                )}
              </View>
            </View>

            {(restrictionStatus && restrictionStatus !== 'none') || playsUp ? (
              <TouchableOpacity
                style={[
                  styles.restrictionCard,
                  {
                    borderColor:
                      restrictionStatus && restrictionStatus !== 'none'
                        ? getRestrictionStatusColor(restrictionStatus)
                        : '#8B5CF6',
                  },
                ]}
                activeOpacity={canEdit ? 0.7 : 1}
                disabled={!canEdit}
                onPress={handleOpenVoluntaryRestriction}
                testID="restriction-reselect"
              >
                <AlertTriangle
                  size={20}
                  color={
                    restrictionStatus && restrictionStatus !== 'none'
                      ? getRestrictionStatusColor(restrictionStatus)
                      : '#8B5CF6'
                  }
                />
                <View style={styles.restrictionContent}>
                  <View style={styles.placementChipRow}>
                    {playsUp && (
                      <View style={[styles.placementChip, { backgroundColor: '#EDE9FE' }]}>
                        <Text style={[styles.placementChipText, { color: '#8B5CF6' }]}>
                          Playing Up
                          {playUpAgeGroup ? ` → ${playUpAgeGroup}` : ''}
                        </Text>
                      </View>
                    )}
                    {restrictionStatus && restrictionStatus !== 'none' && (
                      <View
                        style={[
                          styles.placementChip,
                          {
                            backgroundColor:
                              restrictionStatus === 'penny_player' ? '#FEF3C7' : '#DBEAFE',
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.placementChipText,
                            { color: getRestrictionStatusColor(restrictionStatus) },
                          ]}
                        >
                          {getRestrictionStatusLabel(restrictionStatus)}
                        </Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.restrictionSubtitle}>
                    {canEdit
                      ? 'Tap to change or clear this placement'
                      : 'Special placement set by an admin'}
                  </Text>
                </View>
                {canEdit && <ChevronRight size={18} color={Colors.textMuted} />}
              </TouchableOpacity>
            ) : canEdit ? (
              <TouchableOpacity
                style={[styles.restrictionCard, styles.specialPlacementCard]}
                activeOpacity={0.7}
                onPress={handleOpenVoluntaryRestriction}
                testID="restriction-add"
              >
                <Shield size={20} color={Colors.primary} />
                <View style={styles.restrictionContent}>
                  <Text style={[styles.restrictionTitle, { color: Colors.primary }]}>
                    Special Placement
                  </Text>
                  <Text style={styles.restrictionSubtitle}>
                    Tap to play up, join open division, or mark as pennie player
                  </Text>
                </View>
                <ChevronRight size={18} color={Colors.textMuted} />
              </TouchableOpacity>
            ) : null}
          </View>

          <View style={styles.statusSection}>
            <View
              style={[
                styles.statusBanner,
                isComplete ? styles.statusComplete : styles.statusIncomplete,
              ]}
            >
              {isComplete ? (
                <CheckCircle2 size={24} color={Colors.success} />
              ) : (
                <Circle size={24} color={Colors.warning} />
              )}
              <Text
                style={[
                  styles.statusText,
                  isComplete ? styles.statusTextComplete : styles.statusTextIncomplete,
                ]}
              >
                {isCheckedIn
                  ? 'Checked In'
                  : isComplete
                    ? 'Ready to Check In'
                    : 'Verification Incomplete'}
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
            <>
              <TouchableOpacity
                style={[styles.saveButton, isComplete && styles.saveButtonComplete]}
                onPress={handleSave}
                disabled={isUpdating || isUploading || isUncheckingIn}
                activeOpacity={0.8}
              >
                <Save size={22} color={Colors.white} />
                <Text style={styles.saveButtonText}>
                  {isUploading
                    ? 'Uploading Photo...'
                    : isUpdating
                      ? 'Syncing...'
                      : isCheckedIn
                        ? 'Save Changes'
                        : isComplete
                          ? 'Complete Check-In'
                          : 'Complete Required Fields'}
                </Text>
              </TouchableOpacity>

              {player.checkedIn && (
                <TouchableOpacity
                  style={styles.uncheckButton}
                  onPress={handleUncheckIn}
                  disabled={isUpdating || isUploading || isUncheckingIn}
                  activeOpacity={0.8}
                  testID="uncheck-in-button"
                >
                  <RotateCcw size={18} color={Colors.error} />
                  <Text style={styles.uncheckButtonText}>
                    {isUncheckingIn ? 'Undoing…' : 'Wrong Child? Undo Check-In'}
                  </Text>
                </TouchableOpacity>
              )}
            </>
          ) : (
            <View style={styles.viewOnlyBanner}>
              <Text style={styles.viewOnlyText}>View-Only Mode</Text>
              <Text style={styles.viewOnlySubtext}>Go to Settings to unlock admin access</Text>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      {player && isAdmin && (
        <ClubPickerModal
          visible={showClubModal}
          onClose={() => setShowClubModal(false)}
          currentClub={player.club}
          clubs={clubs}
          onSelect={async (clubName) => {
            setIsSavingClub(true);
            try {
              console.log('Changing club for player:', player.id, '->', clubName);
              await updatePlayer({ ...player, club: clubName });
              if (Platform.OS !== 'web') {
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              }
            } catch (error) {
              console.error('Failed to save club change:', error);
              const message = error instanceof Error ? error.message : 'Unknown error';
              Alert.alert('Could Not Change Club', message);
            } finally {
              setIsSavingClub(false);
            }
          }}
        />
      )}

      {player && canEdit && (
        <TeamAssignmentModal
          visible={showTeamModal}
          onClose={() => setShowTeamModal(false)}
          currentTeamName={player.teamName}
          playerClub={player.club}
          playerAgeGroup={playUpAgeGroup || player.ageGroup || calculatedAgeGroup || ""}
          allTeams={teams}
          onSelect={async (teamName) => {
            setIsSavingTeam(true);
            try {
              console.log('Saving team assignment for player:', player.id, '->', teamName);
              await updatePlayer({ ...player, teamName });
              if (Platform.OS !== 'web') {
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              }
            } catch (error) {
              console.error('Failed to save team assignment:', error);
              const message = error instanceof Error ? error.message : 'Unknown error';
              Alert.alert('Could Not Save Team', message);
            } finally {
              setIsSavingTeam(false);
            }
          }}
          onClear={async () => {
            setIsSavingTeam(true);
            try {
              console.log('Clearing team assignment for player:', player.id);
              await updatePlayer({ ...player, teamName: '' });
            } catch (error) {
              console.error('Failed to clear team assignment:', error);
              const message = error instanceof Error ? error.message : 'Unknown error';
              Alert.alert('Could Not Clear Team', message);
            } finally {
              setIsSavingTeam(false);
            }
          }}
        />
      )}

      {player && (
        <WeightRestrictionModal
          visible={showWeightModal}
          onClose={() => {
            setShowWeightModal(false);
            // Edge case: coach toggled Play Up in voluntary mode and then
            // dismissed the modal without picking a restriction. Auto-save
            // so the playsUp / playUpAgeGroup change isn't silently lost.
            if (restrictionModalMode === 'voluntary' && player) {
              const finalAgeGroup = playsUp && playUpAgeGroup ? playUpAgeGroup : player.ageGroup;
              void updatePlayer({
                ...player,
                isAgeVerified,
                photoUri: photoUri ?? player.photoUri,
                weight: (weight.trim() || player.weight || ''),
                restrictionStatus,
                playsUp,
                ageGroup: finalAgeGroup || player.ageGroup,
                calculatedAgeGroup: calculatedAgeGroup || undefined,
              }).catch((err) => {
                console.warn('[player] auto-save on voluntary close failed:', err);
              });
            }
          }}
          onSelect={handleRestrictionSelect}
          playsUp={playsUp}
          onPlaysUpChange={handlePlaysUpChange}
          playerName={`${player.firstName} ${player.lastName}`}
          mode={restrictionModalMode}
          currentWeight={parseFloat(pendingWeight) || 0}
          weightLimit={
            checkWeightRestriction(effectiveAgeGroup, pendingWeight, player.division).limit || 0
          }
          currentAgeGroup={effectiveAgeGroup}
        />
      )}

      <Modal
        visible={isPhotoExpanded}
        transparent={false}
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setIsPhotoExpanded(false)}
      >
        <View style={styles.expandedPhotoContainer}>
          <StatusBar barStyle="light-content" />
          <TouchableOpacity
            style={styles.closeButton}
            onPress={() => setIsPhotoExpanded(false)}
            activeOpacity={0.7}
          >
            <X size={28} color={Colors.white} />
          </TouchableOpacity>
          {photoUri ? (
            <Image
              source={{ uri: photoUri }}
              style={styles.expandedPhoto}
              resizeMode="contain"
            />
          ) : null}
        </View>
      </Modal>
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
  teamBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.primary,
  },
  teamBadgeText: {
    color: Colors.white,
  },
  teamBadgeEmpty: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.surfaceAlt,
  },
  teamBadgeEmptyText: {
    color: Colors.textMuted,
  },
  clubCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 12,
  },
  teamCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 12,
  },
  teamCardContent: {
    flex: 1,
  },
  teamCardLabel: {
    fontSize: 12,
    fontWeight: '600' as const,
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    marginBottom: 2,
  },
  teamCardValue: {
    fontSize: 15,
    fontWeight: '600' as const,
    color: Colors.text,
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
  ageGroupOverrideNote: {
    backgroundColor: '#EDE9FE',
  },
  ageGroupOverrideNoteText: {
    color: '#7C3AED',
  },
  ageOverrideCard: {
    marginTop: 12,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  ageOverrideTitle: {
    fontSize: 14,
    fontWeight: '700' as const,
    color: Colors.text,
    marginBottom: 4,
  },
  ageOverrideHelp: {
    fontSize: 12,
    color: Colors.textSecondary,
    lineHeight: 17,
    marginBottom: 10,
  },
  ageOverrideChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  ageOverrideChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surfaceAlt,
  },
  ageOverrideChipActive: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryLight,
  },
  ageOverrideChipText: {
    fontSize: 13,
    fontWeight: '600' as const,
    color: Colors.textSecondary,
  },
  ageOverrideChipTextActive: {
    color: Colors.primary,
  },
  ageOverrideSaving: {
    marginTop: 8,
    fontSize: 12,
    color: Colors.textSecondary,
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
  specialPlacementCard: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryLight,
    borderStyle: 'dashed',
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
  placementChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 4,
  },
  placementChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  placementChipText: {
    fontSize: 12,
    fontWeight: '600' as const,
  },
  restrictionSubtitle: {
    fontSize: 12,
    color: Colors.textSecondary,
  },
  uncheckButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    borderRadius: 14,
    paddingVertical: 14,
    marginTop: 12,
    gap: 8,
    borderWidth: 1,
    borderColor: Colors.error,
  },
  uncheckButtonText: {
    fontSize: 15,
    fontWeight: '600' as const,
    color: Colors.error,
  },
  expandedPhotoContainer: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  expandedPhoto: {
    width: '100%' as const,
    height: '80%' as const,
  },
  closeButton: {
    position: 'absolute',
    top: 60,
    right: 20,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
});