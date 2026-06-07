import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { WifiOff, RefreshCw } from 'lucide-react-native';
import { useRegistration } from '@/contexts/RegistrationContext';

export default function CloudStaleBanner() {
  const { cloudRefreshError, cloudRefreshFailedAt, retryCloudRefresh, isOnline } =
    useRegistration();

  if (!cloudRefreshError) return null;

  const timeAgo = cloudRefreshFailedAt
    ? (() => {
        const diff = Date.now() - new Date(cloudRefreshFailedAt).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return 'just now';
        if (mins === 1) return '1 minute ago';
        if (mins < 60) return `${mins} minutes ago`;
        const hours = Math.floor(mins / 60);
        return `${hours}h ago`;
      })()
    : '';

  return (
    <TouchableOpacity
      style={styles.banner}
      onPress={() => {
        void retryCloudRefresh();
      }}
      activeOpacity={0.8}
    >
      <WifiOff size={16} color="#B45309" />
      <View style={styles.textContainer}>
        <Text style={styles.label}>
          {isOnline
            ? `Cloud sync failed ${timeAgo}`
            : 'You are offline'}
        </Text>
        <Text style={styles.hint}>Data may be stale — tap to retry</Text>
      </View>
      <RefreshCw size={16} color="#B45309" />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFF7ED',
    borderBottomWidth: 1,
    borderBottomColor: '#FED7AA',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 10,
  },
  textContainer: {
    flex: 1,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#92400E',
  },
  hint: {
    fontSize: 12,
    color: '#B45309',
    marginTop: 2,
  },
});
