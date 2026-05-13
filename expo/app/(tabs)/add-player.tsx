import React, { useState, useMemo, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Image,
} from 'react-native';
import { UserPlus, Check, Camera, CheckCircle2, Circle, User, AlertTriangle } from 'lucide-react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRegistration } from '@/contexts/RegistrationContext';
import { useOrganization } from '@/contexts/OrganizationContext';
import { uploadPlayerPhoto } from '@/lib/supabase';
import FilterDropdown from '@/components/FilterDropdown';
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

function formatDateOfBirth(input: string, previous: string): string {
  const isDeleting = input.length < previous.length;
  const digits = input.replace(/\D/g, '').slice(0, 8);
  if (digits.length === 0) return '';

  let formatted = digits;
  if (digits.length >= 5) {
    formatted = `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
  } else if (digits.length >= 3) {
    formatted = `${digits.slice(0, 2)}/${digits.slice(2)}`;
  } else {
    formatted = digits;
  }

  if (isDeleting && (previous.endsWith('/') && formatted.length === previous.length - 1)) {
    return formatted;
  }

  if (!isDeleting) {
    if (digits.length === 2) formatted = `${digits}/`;
    else if (digits.length === 4) formatted = `${digits.slice(0, 2)}/${digits.slice(2, 4)}/`;
  }

  return formatted;
}


export default function AddPlayerScreen() {
  const insets = useSafeAreaInsets();
  const { clubs, ageGroups, divisions, addPlayer, isAdding } = useRegistration();
  const { currentOrg } = useOrganization();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [club, setClub] = useState<string | null>(null);
  const [ageGroup, setAgeGroup] = useState<string | null>(null);
  const [division, setDivision] = useState<string | null>(null);
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [weight, setWeight] = useState('');
  const [isAgeVerified, setIsAgeVerified] = useState(false);
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [restrictionStatus, setRestrictionStatus] = useState<RestrictionStatus>('none');
  const [playsUp, setPlaysUp] = useState<boolean>(false);
  const [showWeightModal, setShowWeightModal] = useState(false);
  const [pendingWeight, setPendingWeight] = useState('');
  const [playUpAgeGroup, setPlayUpAgeGroup] = useState<string | null>(null);

  const resetForm = () => {
    setFirstName('');
    setLastName('');
    setClub(null);
    setAgeGroup(null);
    setDivision(null);
    setDateOfBirth('');
    setWeight('');
    setIsAgeVerified(false);
    setPhotoUri(null);
    setRestrictionStatus('none');
    setPlaysUp(false);
    setPlayUpAgeGroup(null);
  };

  const handleDateOfBirthChange = (text: string) => {
    const formatted = formatDateOfBirth(text, dateOfBirth);
    setDateOfBirth(formatted);
  };

  const calculatedAgeGroup = useMemo(() => {
    if (!dateOfBirth) return null;
    return calculateAgeGroup(dateOfBirth);
  }, [dateOfBirth]);

  useEffect(() => {
    if (calculatedAgeGroup && !ageGroup) {
      setAgeGroup(calculatedAgeGroup);
    }
  }, [calculatedAgeGroup, ageGroup]);

  // `ageGroup` is the intentional roster placement. It can be manually
  // changed for admin waivers, so do not let the DOB calculation overwrite it.
  const effectiveAgeGroup = ageGroup || calculatedAgeGroup || '';

  const handleWeightChange = (newWeight: string) => {
    setWeight(newWeight);
  };

  useEffect(() => {
    if (!weight.trim() || !division || !effectiveAgeGroup) {
      return;
    }
    if (showWeightModal) return;

    const restriction = checkWeightRestriction(
      effectiveAgeGroup,
      weight,
      division
    );

    if (restriction.isOverweight && restriction.limit) {
      if (restrictionStatus === 'none' && !playsUp) {
        console.log('[add-player] weight over limit, prompting restriction modal', {
          weight,
          limit: restriction.limit,
          ageGroup: effectiveAgeGroup,
          division,
        });
        setPendingWeight(weight);
        setShowWeightModal(true);
      }
    } else {
      if (restrictionStatus !== 'none') {
        setRestrictionStatus('none');
        setPlayUpAgeGroup(null);
      }
    }
  }, [weight, division, effectiveAgeGroup, showWeightModal, restrictionStatus, playsUp]);

  const handleRestrictionSelect = (status: RestrictionStatus) => {
    setRestrictionStatus(status);
    setShowWeightModal(false);
  };

  const handlePlaysUpChange = (next: boolean) => {
    setPlaysUp(next);
    if (next) {
      const nextAgeGroup = getNextAgeGroup(effectiveAgeGroup);
      if (nextAgeGroup) {
        console.log(`Moving player from ${effectiveAgeGroup} to ${nextAgeGroup}`);
        setPlayUpAgeGroup(nextAgeGroup);
        // Playing up resolves the restricted-weight popup by moving the kid
        // into the next age bracket. It is not a contact restriction, so the
        // row should save as plays_up=true + restriction_status='none'.
        setRestrictionStatus('none');
        setShowWeightModal(false);
      }
    } else {
      setPlayUpAgeGroup(null);
    }
  };

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
        console.log('[add-player] photo captured', {
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
      console.error('[add-player] camera error:', err);
      Alert.alert('Camera error', message);
    }
  };

  const handleSubmit = async () => {
    const missingFields: string[] = [];
    
    if (!firstName.trim()) {
      missingFields.push('First Name');
    }
    if (!lastName.trim()) {
      missingFields.push('Last Name');
    }
    if (!dateOfBirth.trim()) {
      missingFields.push('Date of Birth');
    }
    if (!weight.trim()) {
      missingFields.push('Weight');
    }
    if (!club) {
      missingFields.push('Club');
    }
    if (!ageGroup) {
      missingFields.push('Age Group');
    }
    if (!division) {
      missingFields.push('Division');
    }
    if (!isAgeVerified) {
      missingFields.push('Age Verification');
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

    console.log('Adding new player:', firstName, lastName);

    try {
      let finalPhotoUri = photoUri;
      
      if (photoUri && !photoUri.startsWith('http')) {
        console.log('Uploading photo to cloud storage...');
        const tempPlayerId = `new-${Date.now()}`;
        try {
          const uploadedUrl = await uploadPlayerPhoto(
            tempPlayerId,
            photoUri,
            currentOrg?.id ?? 'utah-little-rugby',
            3,
            `${firstName.trim()} ${lastName.trim()}`.trim()
          );
          console.log('Photo uploaded successfully:', uploadedUrl);
          finalPhotoUri = uploadedUrl;
        } catch (uploadError) {
          const message = uploadError instanceof Error ? uploadError.message : String(uploadError);
          console.error('Photo upload error:', uploadError);
          Alert.alert('Photo upload failed', `Photo upload failed: ${message}`, [{ text: 'OK' }]);
          return;
        }
      }

      await addPlayer({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        club: club || '',
        ageGroup: playUpAgeGroup || ageGroup || calculatedAgeGroup || '',
        division: division || '',
        teamName: '',
        dateOfBirth: dateOfBirth.trim(),
        weight: weight.trim(),
        isAgeVerified: true,
        photoUri: finalPhotoUri,
        checkedIn: true,
        checkedInAt: new Date().toISOString(),
        restrictionStatus,
        playsUp,
        calculatedAgeGroup: calculatedAgeGroup || undefined,
      });

      Alert.alert(
        'Player Added',
        `${firstName} ${lastName} has been added to the registration list.`,
        [{ text: 'OK', onPress: resetForm }]
      );
    } catch (error) {
      console.error('Error adding player:', error);
      Alert.alert('Error', 'Failed to add player. Please try again.');
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + 20 }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <View style={styles.iconContainer}>
            <UserPlus size={32} color={Colors.primary} />
          </View>
          <Text style={styles.title}>Add Walk-Up Player</Text>
          <Text style={styles.subtitle}>
            Register a player who did not sign up ahead of time
          </Text>
        </View>

        <View style={styles.form}>
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Player Information</Text>
            
            <View style={styles.row}>
              <View style={styles.inputGroup}>
                <Text style={styles.label}>First Name *</Text>
                <TextInput
                  style={styles.input}
                  value={firstName}
                  onChangeText={setFirstName}
                  placeholder="First name"
                  placeholderTextColor={Colors.textMuted}
                  autoCapitalize="words"
                  testID="first-name-input"
                />
              </View>
              <View style={styles.spacer} />
              <View style={styles.inputGroup}>
                <Text style={styles.label}>Last Name *</Text>
                <TextInput
                  style={styles.input}
                  value={lastName}
                  onChangeText={setLastName}
                  placeholder="Last name"
                  placeholderTextColor={Colors.textMuted}
                  autoCapitalize="words"
                  testID="last-name-input"
                />
              </View>
            </View>

            <View style={styles.row}>
              <View style={styles.inputGroup}>
                <Text style={styles.label}>Date of Birth *</Text>
                <TextInput
                  style={styles.input}
                  value={dateOfBirth}
                  onChangeText={handleDateOfBirthChange}
                  placeholder="MM/DD/YYYY"
                  placeholderTextColor={Colors.textMuted}
                  keyboardType="number-pad"
                  maxLength={10}
                />
                {calculatedAgeGroup ? (
                  <Text style={styles.ageGroupHint}>
                    {`Age Group: ${playUpAgeGroup || ageGroup || calculatedAgeGroup}${playUpAgeGroup ? ' (Playing Up)' : ''}`}
                  </Text>
                ) : null}
              </View>
              <View style={styles.spacer} />
              <View style={styles.inputGroup}>
                <Text style={styles.label}>Weight (lbs) *</Text>
                <TextInput
                  style={styles.input}
                  value={weight}
                  onChangeText={handleWeightChange}
                  placeholder="Required"
                  placeholderTextColor={Colors.textMuted}
                  keyboardType="numeric"
                />
              </View>
            </View>

            {restrictionStatus !== 'none' ? (
              <View style={[styles.restrictionCard, { borderColor: getRestrictionStatusColor(restrictionStatus) }]}>
                <AlertTriangle size={18} color={getRestrictionStatusColor(restrictionStatus)} />
                <View style={styles.restrictionContent}>
                  <Text style={[styles.restrictionTitle, { color: getRestrictionStatusColor(restrictionStatus) }]}>
                    {getRestrictionStatusLabel(restrictionStatus)}
                  </Text>
                  <Text style={styles.restrictionSubtitle}>
                    Player is over weight limit for restricted division
                  </Text>
                </View>
              </View>
            ) : null}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Check-In Verification *</Text>

            <TouchableOpacity
              style={styles.photoContainer}
              onPress={handleTakePhoto}
              activeOpacity={0.8}
            >
              {photoUri ? (
                <Image source={{ uri: photoUri }} style={styles.photo} />
              ) : (
                <View style={styles.photoPlaceholder}>
                  <User size={40} color={Colors.textMuted} />
                  <Text style={styles.photoPlaceholderText}>Tap to take photo</Text>
                </View>
              )}
              <View style={styles.cameraButton}>
                <Camera size={18} color={Colors.white} />
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.verificationCard, isAgeVerified && styles.verificationCardActive]}
              onPress={handleToggleVerified}
              activeOpacity={0.7}
            >
              {isAgeVerified ? (
                <CheckCircle2 size={26} color={Colors.success} />
              ) : (
                <Circle size={26} color={Colors.textMuted} />
              )}
              <View style={styles.verificationContent}>
                <Text style={styles.verificationTitle}>Age Verified</Text>
                <Text style={styles.verificationSubtitle}>
                  {isAgeVerified ? 'Birth certificate or ID confirmed' : 'Tap to confirm age verification'}
                </Text>
              </View>
            </TouchableOpacity>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Registration Details *</Text>
            
            <View style={styles.dropdownRow}>
              <FilterDropdown
                label="Club"
                value={club}
                options={clubs}
                onSelect={setClub}
                placeholder="Select Club"
              />
            </View>

            <View style={styles.row}>
              <FilterDropdown
                label="Age Group"
                value={ageGroup}
                options={ageGroups}
                onSelect={setAgeGroup}
                placeholder="Select"
              />
              <View style={styles.spacer} />
              <FilterDropdown
                label="Division"
                value={division}
                options={divisions}
                onSelect={setDivision}
                placeholder="Select"
              />
            </View>
          </View>

        </View>

        <TouchableOpacity
          style={[styles.submitButton, isAdding && styles.submitButtonDisabled]}
          onPress={handleSubmit}
          disabled={isAdding}
          activeOpacity={0.8}
          testID="submit-button"
        >
          <Check size={22} color={Colors.white} />
          <Text style={styles.submitButtonText}>
            {isAdding ? 'Adding Player...' : 'Add Player'}
          </Text>
        </TouchableOpacity>
      </ScrollView>

      <WeightRestrictionModal
        visible={showWeightModal}
        onClose={() => setShowWeightModal(false)}
        onSelect={handleRestrictionSelect}
        playsUp={playsUp}
        onPlaysUpChange={handlePlaysUpChange}
        playerName={`${firstName} ${lastName}`.trim() || 'This player'}
        currentWeight={parseFloat(pendingWeight) || 0}
        weightLimit={checkWeightRestriction(effectiveAgeGroup, pendingWeight, division || '').limit || 0}
        currentAgeGroup={effectiveAgeGroup}
      />

      
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 20,
    paddingBottom: 40,
  },
  header: {
    alignItems: 'center',
    marginBottom: 24,
  },
  iconContainer: {
    width: 70,
    height: 70,
    borderRadius: 35,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: '700' as const,
    color: Colors.text,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  form: {
    marginBottom: 24,
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
  row: {
    flexDirection: 'row',
    marginBottom: 12,
  },
  dropdownRow: {
    marginBottom: 12,
  },
  spacer: {
    width: 12,
  },
  inputGroup: {
    flex: 1,
    marginBottom: 12,
  },
  label: {
    fontSize: 12,
    fontWeight: '600' as const,
    color: Colors.textSecondary,
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  input: {
    backgroundColor: Colors.surface,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: Colors.text,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  submitButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primary,
    borderRadius: 14,
    paddingVertical: 16,
    gap: 10,
  },
  submitButtonDisabled: {
    opacity: 0.6,
  },
  submitButtonText: {
    fontSize: 18,
    fontWeight: '600' as const,
    color: Colors.white,
  },
  
  photoContainer: {
    alignSelf: 'center',
    position: 'relative',
    marginBottom: 16,
  },
  photo: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: Colors.surfaceAlt,
  },
  photoPlaceholder: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: Colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: Colors.border,
    borderStyle: 'dashed',
  },
  photoPlaceholderText: {
    fontSize: 11,
    color: Colors.textMuted,
    marginTop: 4,
    textAlign: 'center',
  },
  cameraButton: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: Colors.white,
  },
  verificationCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    padding: 14,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: Colors.border,
  },
  verificationCardActive: {
    borderColor: Colors.success,
    backgroundColor: Colors.successLight,
  },
  verificationContent: {
    flex: 1,
    marginLeft: 12,
  },
  verificationTitle: {
    fontSize: 15,
    fontWeight: '600' as const,
    color: Colors.text,
    marginBottom: 2,
  },
  verificationSubtitle: {
    fontSize: 12,
    color: Colors.textSecondary,
  },
  ageGroupHint: {
    fontSize: 12,
    color: Colors.success,
    marginTop: 4,
    fontWeight: '500' as const,
  },
  restrictionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    padding: 14,
    borderRadius: 12,
    marginBottom: 12,
    borderWidth: 2,
  },
  restrictionContent: {
    flex: 1,
    marginLeft: 12,
  },
  restrictionTitle: {
    fontSize: 14,
    fontWeight: '600' as const,
    marginBottom: 2,
  },
  restrictionSubtitle: {
    fontSize: 11,
    color: Colors.textSecondary,
  },
});
