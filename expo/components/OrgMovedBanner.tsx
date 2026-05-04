import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { ArrowRightCircle, AlertTriangle } from 'lucide-react-native';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useRegistration } from '@/contexts/RegistrationContext';
import { clearAllReconcileFlags } from '@/lib/finalReconcile';
import Colors from '@/constants/colors';

const OLD_ORG_CODE = '8DJ5JM';
const NEW_ORG_CODE = 'HX85EH';

export default function OrgMovedBanner() {
  const { currentOrg, joinOrgByCode } = useOrganization();
  const { flushCloudQueueNow } = useRegistration() as unknown as {
    flushCloudQueueNow: () => Promise<unknown>;
  };
  const [busy, setBusy] = useState<boolean>(false);

  const isOnOldOrg =
    !!currentOrg &&
    currentOrg.code?.toUpperCase().trim() === OLD_ORG_CODE;

  const handleSwitch = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      console.log('[orgMoved] flushing pending edits from old org before switching');
      try {
        await flushCloudQueueNow();
      } catch (err) {
        console.warn('[orgMoved] pre-switch flush failed (continuing):', err);
      }

      console.log('[orgMoved] switching to', NEW_ORG_CODE);
      const userId = `user-${Date.now()}`;
      const result = await joinOrgByCode(NEW_ORG_CODE, userId, 'Volunteer', '');
      if (!result) {
        Alert.alert(
          'Could not switch',
          `We couldn't reach ${NEW_ORG_CODE} just now. Please check your connection and try again.`,
        );
        return;
      }

      console.log('[orgMoved] joined new org, clearing reconcile flags and reconciling');
      try {
        await clearAllReconcileFlags();
      } catch (err) {
        console.warn('[orgMoved] clearAllReconcileFlags failed (non-fatal):', err);
      }

      try {
        await flushCloudQueueNow();
      } catch (err) {
        console.warn('[orgMoved] post-switch reconcile failed:', err);
      }

      Alert.alert(
        'Switched to new org',
        `You're now on ${result.name} (${NEW_ORG_CODE}). Your cached edits have been merged into the new roster.`,
      );
    } finally {
      setBusy(false);
    }
  }, [busy, joinOrgByCode, flushCloudQueueNow]);

  if (!isOnOldOrg) return null;

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={handleSwitch}
      disabled={busy}
      style={[styles.banner, busy && styles.bannerDisabled]}
      testID="org-moved-banner"
    >
      <View style={styles.iconWrap}>
        {busy ? (
          <ActivityIndicator size="small" color="#7C2D12" />
        ) : (
          <AlertTriangle size={18} color="#7C2D12" />
        )}
      </View>
      <View style={styles.textWrap}>
        <Text style={styles.title}>This season&apos;s org has moved</Text>
        <Text style={styles.subtitle}>
          Tap to switch to {NEW_ORG_CODE} and merge your cached edits.
        </Text>
      </View>
      <ArrowRightCircle size={22} color="#7C2D12" />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginHorizontal: 16,
    marginTop: 12,
    backgroundColor: '#FEE2E2',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#FCA5A5',
  },
  bannerDisabled: {
    opacity: 0.7,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#FECACA',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  textWrap: {
    flex: 1,
    paddingRight: 8,
  },
  title: {
    fontSize: 14,
    fontWeight: '700' as const,
    color: '#7C2D12',
  },
  subtitle: {
    fontSize: 12,
    color: '#9A3412',
    marginTop: 2,
  },
});
