import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  ScrollView,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { CloudOff, CloudUpload, X, CheckCircle2, AlertTriangle } from 'lucide-react-native';
import { useRegistration } from '@/contexts/RegistrationContext';
import Colors from '@/constants/colors';

function formatRelative(iso: string | null): string {
  if (!iso) return 'never';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return 'never';
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function describeChange(player: { firstName?: string; lastName?: string }): string {
  const name = `${player.firstName ?? ''} ${player.lastName ?? ''}`.trim();
  return name || 'Unnamed player';
}

export default function CloudSyncBanner() {
  const {
    cloudPendingCount,
    cloudPendingItems,
    isCloudSyncing,
    lastCloudSyncedAt,
    flushCloudQueueNow,
  } = useRegistration() as unknown as {
    cloudPendingCount: number;
    cloudPendingItems: { id: string; player: { firstName?: string; lastName?: string }; lastEditedAt: string; lastError?: string }[];
    isCloudSyncing: boolean;
    lastCloudSyncedAt: string | null;
    flushCloudQueueNow: () => Promise<unknown>;
  };

  const [open, setOpen] = useState<boolean>(false);
  const [syncing, setSyncing] = useState<boolean>(false);

  const handleSyncNow = useCallback(async () => {
    setSyncing(true);
    try {
      await flushCloudQueueNow();
    } finally {
      setSyncing(false);
    }
  }, [flushCloudQueueNow]);

  if (cloudPendingCount === 0) return null;

  const busy = syncing || isCloudSyncing;

  return (
    <>
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={() => setOpen(true)}
        style={styles.banner}
        testID="cloud-sync-banner"
      >
        <View style={styles.bannerIcon}>
          {busy ? (
            <ActivityIndicator size="small" color="#7A4A00" />
          ) : (
            <CloudOff size={18} color="#7A4A00" />
          )}
        </View>
        <View style={styles.bannerText}>
          <Text style={styles.bannerTitle}>
            {cloudPendingCount} change{cloudPendingCount !== 1 ? 's' : ''} not yet synced
          </Text>
          <Text style={styles.bannerSubtitle}>
            Tap to review · Last sync {formatRelative(lastCloudSyncedAt)}
          </Text>
        </View>
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={handleSyncNow}
          disabled={busy}
          style={[styles.syncBtn, busy && styles.syncBtnDisabled]}
          testID="cloud-sync-banner-retry"
        >
          {busy ? (
            <ActivityIndicator size="small" color={Colors.white} />
          ) : (
            <>
              <CloudUpload size={14} color={Colors.white} />
              <Text style={styles.syncBtnText}>Sync</Text>
            </>
          )}
        </TouchableOpacity>
      </TouchableOpacity>

      <Modal
        visible={open}
        transparent
        animationType={Platform.OS === 'web' ? 'fade' : 'slide'}
        onRequestClose={() => setOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Unsynced changes</Text>
              <TouchableOpacity onPress={() => setOpen(false)} style={styles.modalClose}>
                <X size={22} color={Colors.text} />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalSubtitle}>
              These edits live on this device and haven&apos;t been confirmed by the
              cloud yet. Tap &quot;Sync Now&quot; to push them.
            </Text>

            <ScrollView style={styles.modalList} contentContainerStyle={{ paddingBottom: 8 }}>
              {cloudPendingItems.map((item) => (
                <View key={item.id} style={styles.itemRow}>
                  <View style={styles.itemDot} />
                  <View style={styles.itemText}>
                    <Text style={styles.itemName}>{describeChange(item.player)}</Text>
                    <Text style={styles.itemMeta}>
                      Edited {formatRelative(item.lastEditedAt)}
                      {item.lastError ? ` · ${item.lastError}` : ''}
                    </Text>
                  </View>
                  {item.lastError ? (
                    <AlertTriangle size={16} color={Colors.warning} />
                  ) : (
                    <CheckCircle2 size={16} color={Colors.textMuted} />
                  )}
                </View>
              ))}
              {cloudPendingItems.length === 0 && (
                <Text style={styles.modalSubtitle}>No pending changes 🎉</Text>
              )}
            </ScrollView>

            <TouchableOpacity
              activeOpacity={0.85}
              onPress={handleSyncNow}
              disabled={busy}
              style={[styles.modalSyncBtn, busy && styles.syncBtnDisabled]}
              testID="cloud-sync-modal-sync"
            >
              {busy ? (
                <ActivityIndicator size="small" color={Colors.white} />
              ) : (
                <>
                  <CloudUpload size={18} color={Colors.white} />
                  <Text style={styles.modalSyncBtnText}>Sync Now</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginHorizontal: 16,
    marginTop: 12,
    backgroundColor: '#FEF3C7',
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#FDE68A',
  },
  bannerIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#FDE68A',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  bannerText: {
    flex: 1,
  },
  bannerTitle: {
    fontSize: 14,
    fontWeight: '700' as const,
    color: '#7A4A00',
  },
  bannerSubtitle: {
    fontSize: 12,
    color: '#92400E',
    marginTop: 2,
  },
  syncBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#B45309',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    gap: 6,
    minWidth: 64,
    justifyContent: 'center',
  },
  syncBtnDisabled: {
    opacity: 0.7,
  },
  syncBtnText: {
    color: Colors.white,
    fontWeight: '700' as const,
    fontSize: 13,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 28,
    maxHeight: '80%',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700' as const,
    color: Colors.text,
  },
  modalClose: {
    padding: 6,
  },
  modalSubtitle: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginBottom: 12,
  },
  modalList: {
    maxHeight: 320,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  itemDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.warning,
    marginRight: 10,
  },
  itemText: {
    flex: 1,
  },
  itemName: {
    fontSize: 15,
    fontWeight: '600' as const,
    color: Colors.text,
  },
  itemMeta: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  modalSyncBtn: {
    marginTop: 12,
    backgroundColor: Colors.primary,
    borderRadius: 14,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  modalSyncBtnText: {
    color: Colors.white,
    fontWeight: '700' as const,
    fontSize: 16,
  },
});
