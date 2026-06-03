import React, { useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  ScrollView,
  Alert,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft,
  CheckCircle2,
  Circle,
  ShieldCheck,
  Shield,
  User,
  Camera,
} from 'lucide-react-native';
import * as ImagePicker from 'expo-image-picker';
import { useRegistration } from '@/contexts/RegistrationContext';
import { useAuth } from '@/contexts/AuthContext';
import Colors from '@/constants/colors';
import type { Coach } from '@/types';

export default function CoachDetailScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { isAdmin, canEdit } = useAuth();
  const { coaches, coachTeams, updateCoach } = useRegistration() as {
    coaches: Coach[];
    coachTeams: { coachId: string; teamName: string; club: string; ageGroup: string; division: string }[];
    updateCoach: (coach: Coach) => Promise<void>;
  };

  const coach = useMemo(() => coaches.find((c) => c.id === id) ?? null, [coaches, id]);

  const coachTeamEntries = useMemo(
    () => coachTeams.filter((ct) => ct.coachId === id),
    [coachTeams, id],
  );

  const handleCheckIn = useCallback(async () => {
    if (!coach) return;
    const now = new Date().toISOString();
    const updated: Coach = { ...coach, checkedIn: true, checkedInAt: now };
    try {
      await updateCoach(updated);
    } catch (err) {
      Alert.alert('Error', 'Failed to check in coach. Please try again.');
    }
  }, [coach, updateCoach]);

  const handleUndoCheckIn = useCallback(async () => {
    if (!coach) return;
    const updated: Coach = { ...coach, checkedIn: false, checkedInAt: null };
    try {
      await updateCoach(updated);
    } catch (err) {
      Alert.alert('Error', 'Failed to undo check-in. Please try again.');
    }
  }, [coach, updateCoach]);

  const handleToggleCertified = useCallback(async () => {
    if (!coach || !isAdmin) return;
    const updated: Coach = { ...coach, isCertified: !coach.isCertified };
    try {
      await updateCoach(updated);
    } catch (err) {
      Alert.alert('Error', 'Failed to update certification. Please try again.');
    }
  }, [coach, isAdmin, updateCoach]);

  const handleTakePhoto = useCallback(async () => {
    if (!coach || !canEdit) return;
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Camera access is needed to take a photo.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      quality: 0.8,
      allowsEditing: true,
      aspect: [1, 1],
    });
    if (result.canceled || !result.assets?.[0]?.uri) return;
    const updated: Coach = { ...coach, photoUri: result.assets[0].uri };
    try {
      await updateCoach(updated);
    } catch (err) {
      Alert.alert('Error', 'Failed to save photo. Please try again.');
    }
  }, [coach, canEdit, updateCoach]);

  if (!coach) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <ArrowLeft size={24} color={Colors.white} />
          </TouchableOpacity>
          <Text style={styles.title}>Coach Not Found</Text>
        </View>
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>This coach could not be found.</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <ArrowLeft size={24} color={Colors.white} />
        </TouchableOpacity>
        <Text style={styles.title}>Coach Details</Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Photo Section */}
        <View style={styles.photoSection}>
          <TouchableOpacity
            style={styles.photoWrapper}
            onPress={handleTakePhoto}
            disabled={!canEdit}
            activeOpacity={canEdit ? 0.7 : 1}
          >
            {coach.photoUri ? (
              <Image source={{ uri: coach.photoUri }} style={styles.photo} />
            ) : (
              <View style={styles.photoPlaceholder}>
                <User size={48} color={Colors.textMuted} />
              </View>
            )}
            {canEdit && (
              <View style={styles.cameraBadge}>
                <Camera size={14} color={Colors.white} />
              </View>
            )}
          </TouchableOpacity>
          <Text style={styles.coachName}>
            {coach.firstName} {coach.lastName}
          </Text>
        </View>

        {/* Check-in Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Check-In Status</Text>
          {coach.checkedIn ? (
            <View style={styles.statusRow}>
              <CheckCircle2 size={28} color={Colors.success} />
              <View style={styles.statusInfo}>
                <Text style={styles.statusTextCheckedIn}>Checked In</Text>
                {coach.checkedInAt && (
                  <Text style={styles.statusTime}>
                    {new Date(coach.checkedInAt).toLocaleTimeString([], {
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </Text>
                )}
              </View>
              {canEdit && (
                <TouchableOpacity style={styles.undoBtn} onPress={handleUndoCheckIn}>
                  <Text style={styles.undoBtnText}>Undo</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : (
            <TouchableOpacity
              style={styles.checkInBtn}
              onPress={handleCheckIn}
              disabled={!canEdit}
              activeOpacity={0.8}
            >
              <Circle size={24} color={Colors.white} />
              <Text style={styles.checkInBtnText}>Check In Coach</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Certification Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Certification</Text>
          <TouchableOpacity
            style={[
              styles.certRow,
              coach.isCertified && styles.certRowCertified,
            ]}
            onPress={handleToggleCertified}
            disabled={!isAdmin}
            activeOpacity={isAdmin ? 0.7 : 1}
          >
            {coach.isCertified ? (
              <ShieldCheck size={24} color={Colors.success} />
            ) : (
              <Shield size={24} color={Colors.warning} />
            )}
            <Text
              style={[
                styles.certLabel,
                coach.isCertified ? styles.certLabelCertified : styles.certLabelNot,
              ]}
            >
              {coach.isCertified ? 'Certified' : 'Not Certified'}
            </Text>
            {isAdmin && (
              <Text style={styles.certToggleHint}>
                Tap to toggle
              </Text>
            )}
          </TouchableOpacity>
        </View>

        {/* Teams Section */}
        {coachTeamEntries.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Assigned Teams</Text>
            {coachTeamEntries.map((ct) => (
              <View key={ct.teamName + ct.club + ct.ageGroup} style={styles.teamRow}>
                <Text style={styles.teamName}>{ct.teamName || 'Unnamed Team'}</Text>
                <Text style={styles.teamMeta}>
                  {ct.club} • {ct.ageGroup} • {ct.division}
                </Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 14,
    backgroundColor: Colors.primary,
    gap: 12,
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  title: {
    fontSize: 20,
    fontWeight: '700' as const,
    color: Colors.white,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 40,
  },
  photoSection: {
    alignItems: 'center',
    paddingVertical: 24,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  photoWrapper: {
    position: 'relative',
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
    borderStyle: 'dashed' as const,
  },
  cameraBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: Colors.surface,
  },
  coachName: {
    fontSize: 22,
    fontWeight: '700' as const,
    color: Colors.text,
    marginTop: 12,
  },
  section: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600' as const,
    color: Colors.textMuted,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
    marginBottom: 12,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  statusInfo: {
    flex: 1,
  },
  statusTextCheckedIn: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: Colors.success,
  },
  statusTime: {
    fontSize: 13,
    color: Colors.textMuted,
    marginTop: 2,
  },
  undoBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: Colors.border,
  },
  undoBtnText: {
    fontSize: 14,
    fontWeight: '600' as const,
    color: Colors.textSecondary,
  },
  checkInBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    gap: 10,
  },
  checkInBtnText: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: Colors.white,
  },
  certRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surfaceAlt,
    borderRadius: 12,
    padding: 14,
    gap: 10,
  },
  certRowCertified: {
    backgroundColor: Colors.successLight,
  },
  certLabel: {
    fontSize: 16,
    fontWeight: '600' as const,
    flex: 1,
  },
  certLabelCertified: {
    color: Colors.success,
  },
  certLabelNot: {
    color: Colors.warning,
  },
  certToggleHint: {
    fontSize: 12,
    color: Colors.textMuted,
  },
  teamRow: {
    backgroundColor: Colors.surfaceAlt,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
  },
  teamName: {
    fontSize: 15,
    fontWeight: '600' as const,
    color: Colors.text,
    marginBottom: 2,
  },
  teamMeta: {
    fontSize: 12,
    color: Colors.textMuted,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 40,
  },
  emptyText: {
    fontSize: 16,
    color: Colors.textMuted,
  },
});
