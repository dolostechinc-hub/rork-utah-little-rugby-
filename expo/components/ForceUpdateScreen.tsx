import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Linking,
  Platform,
  StyleSheet,
} from 'react-native';
import { useForceUpdate } from '@/contexts/ForceUpdateContext';

export default function ForceUpdateScreen() {
  const { minVersion, currentVersion, storeUrl, isChecking } =
    useForceUpdate();

  const handleUpdate = () => {
    if (storeUrl) {
      void Linking.openURL(storeUrl);
    }
  };

  if (isChecking) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Checking for updates...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.emoji}>📱</Text>
        <Text style={styles.title}>Update Required</Text>
        <Text style={styles.body}>
          A new version of Utah Little Rugby is available and you must update to
          continue. Your current version ({currentVersion}) is older than the
          minimum required version ({minVersion ?? 'unknown'}).
        </Text>
        <Text style={styles.hint}>
          Tap the button below to open the {Platform.OS === 'ios' ? 'App Store' : 'Google Play Store'} and update.
        </Text>
        <TouchableOpacity
          style={styles.button}
          onPress={handleUpdate}
          activeOpacity={0.8}
        >
          <Text style={styles.buttonText}>
            Open {Platform.OS === 'ios' ? 'App Store' : 'Play Store'}
          </Text>
        </TouchableOpacity>
        {!storeUrl && (
          <Text style={styles.fallback}>
            Store link not available. Please search for "Utah Little Rugby" in
            the {Platform.OS === 'ios' ? 'App Store' : 'Google Play Store'}.
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1A472A',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 32,
    alignItems: 'center',
    maxWidth: 360,
    width: '100%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  emoji: {
    fontSize: 48,
    marginBottom: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1A472A',
    marginBottom: 12,
    textAlign: 'center',
  },
  body: {
    fontSize: 15,
    color: '#444444',
    lineHeight: 22,
    textAlign: 'center',
    marginBottom: 16,
  },
  hint: {
    fontSize: 14,
    color: '#666666',
    textAlign: 'center',
    marginBottom: 24,
  },
  button: {
    backgroundColor: '#1A472A',
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 12,
    width: '100%',
    alignItems: 'center',
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  fallback: {
    marginTop: 16,
    fontSize: 13,
    color: '#999999',
    textAlign: 'center',
    lineHeight: 18,
  },
});
