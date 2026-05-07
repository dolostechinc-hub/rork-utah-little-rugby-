import React, { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { CheckCircle2, CloudOff, RefreshCw, WifiOff } from 'lucide-react-native';
import { useRegistration } from '@/contexts/RegistrationContext';
import Colors from '@/constants/colors';

interface RegistrationSyncShape {
  isCloudSyncing: boolean;
  isOnline: boolean;
  cloudPendingCount: number;
  lastCloudSyncedAt: string | null;
}

function formatFreshness(iso: string | null): string {
  if (!iso) return 'never';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return 'never';
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return 'just now';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/**
 * Compact pill that surfaces sync state inside a screen header.
 *
 * Priority of states (most important first):
 *   1. Offline  -> "Offline"
 *   2. Syncing  -> "Syncing…"
 *   3. Pending  -> "N pending"   (CloudSyncBanner already shows the
 *                                  detail panel; this is a heads-up only)
 *   4. Synced   -> "Synced Xs ago" / "Just synced"
 *   5. Unknown  -> "Not synced yet"
 *
 * Re-renders every 15s so the relative time stays roughly accurate
 * without imposing a tight setInterval on the whole tree.
 */
export default function SyncStatusBadge() {
  const {
    isCloudSyncing,
    isOnline,
    cloudPendingCount,
    lastCloudSyncedAt,
  } = useRegistration() as unknown as RegistrationSyncShape;

  // Force a refresh of the relative-time string on a slow tick. The badge
  // is the only consumer of "ago" math; everything else reads the raw
  // ISO string.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 15000);
    return () => clearInterval(id);
  }, []);

  let label: string;
  let tone: 'offline' | 'busy' | 'warn' | 'ok' | 'idle';
  let icon: React.ReactNode;

  if (!isOnline) {
    label = 'Offline';
    tone = 'offline';
    icon = <WifiOff size={12} color={Colors.textSecondary} />;
  } else if (isCloudSyncing) {
    label = 'Syncing…';
    tone = 'busy';
    icon = <ActivityIndicator size="small" color={Colors.warning} />;
  } else if (cloudPendingCount > 0) {
    label = `${cloudPendingCount} pending`;
    tone = 'warn';
    icon = <CloudOff size={12} color={Colors.warning} />;
  } else if (lastCloudSyncedAt) {
    label = `Synced ${formatFreshness(lastCloudSyncedAt)}`;
    tone = 'ok';
    icon = <CheckCircle2 size={12} color={Colors.success} />;
  } else {
    label = 'Not synced yet';
    tone = 'idle';
    icon = <RefreshCw size={12} color={Colors.textMuted} />;
  }

  return (
    <View
      style={[styles.badge, toneStyles[tone]]}
      testID={`sync-status-badge-${tone}`}
      accessible
      accessibilityRole="text"
      accessibilityLabel={`Cloud sync status: ${label}`}
    >
      <View style={styles.iconWrap}>{icon}</View>
      <Text style={[styles.text, toneTextStyles[tone]]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    alignSelf: 'flex-start',
  },
  iconWrap: {
    marginRight: 6,
    width: 14,
    height: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    fontSize: 12,
    fontWeight: '600' as const,
  },
});

// Background + border per tone. Kept separate from the text color so we
// can mix and match (e.g. light bg with darker text) without nested
// arrays at every call site.
const toneStyles = StyleSheet.create({
  offline: {
    backgroundColor: Colors.surfaceAlt,
    borderColor: Colors.border,
  },
  busy: {
    backgroundColor: Colors.warningLight,
    borderColor: Colors.warning,
  },
  warn: {
    backgroundColor: Colors.warningLight,
    borderColor: Colors.warning,
  },
  ok: {
    backgroundColor: Colors.successLight,
    borderColor: Colors.success,
  },
  idle: {
    backgroundColor: Colors.surfaceAlt,
    borderColor: Colors.border,
  },
});

const toneTextStyles = StyleSheet.create({
  offline: { color: Colors.textSecondary },
  busy: { color: '#92400E' },
  warn: { color: '#92400E' },
  ok: { color: '#065F46' },
  idle: { color: Colors.textMuted },
});
