import Constants from 'expo-constants';
import { createClient } from '@supabase/supabase-js';
import { useState, useEffect, useCallback } from 'react';
import createContextHook from '@nkzw/create-context-hook';
import { Platform } from 'react-native';

// Lightweight Supabase client for version checks — only needs the anon key,
// no session persistence. This lives outside the main supabase client so it
// works even when the main client's auth state is mid-transition.
const APP_CONFIG_URL = 'https://pfhkypuavngiidyrrnpn.supabase.co';
const APP_CONFIG_ANON_KEY = 'sb_publishable_o6d-VXD_hzD1AYntd2_guw_dj-8ZyYX';

interface AppConfigRow {
  key: string;
  value: string;
}

// The current app version from app.config.ts (version field)
const CURRENT_VERSION = Constants.expoConfig?.version ?? '0.0.0';

function compareVersions(current: string, minimum: string): boolean {
  const parse = (v: string): number[] =>
    v.split('.').map((n) => parseInt(n, 10) || 0);

  const cur = parse(current);
  const min = parse(minimum);
  const len = Math.max(cur.length, min.length);

  for (let i = 0; i < len; i++) {
    const c = cur[i] ?? 0;
    const m = min[i] ?? 0;
    if (c < m) return true; // current is older → update required
    if (c > m) return false; // current is newer → ok
  }

  return false; // equal
}

async function fetchAppConfig(): Promise<Map<string, string>> {
  const client = createClient(APP_CONFIG_URL, APP_CONFIG_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await client
    .from('app_config')
    .select('key, value');

  if (error) {
    console.warn('[forceUpdate] failed to fetch app_config:', error.message);
    return new Map();
  }

  const map = new Map<string, string>();
  for (const row of (data ?? []) as AppConfigRow[]) {
    map.set(row.key, row.value);
  }
  return map;
}

export const [ForceUpdateProvider, useForceUpdate] = createContextHook(() => {
  const [isUpdateRequired, setIsUpdateRequired] = useState(false);
  const [minVersion, setMinVersion] = useState<string | null>(null);
  const [storeUrl, setStoreUrl] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(true);
  const [checkFailed, setCheckFailed] = useState(false);

  const checkVersion = useCallback(async () => {
    setIsChecking(true);
    setCheckFailed(false);
    try {
      const config = await fetchAppConfig();
      const minVer = config.get('min_version');
      setMinVersion(minVer ?? null);

      if (minVer) {
        const needsUpdate = compareVersions(CURRENT_VERSION, minVer);
        setIsUpdateRequired(needsUpdate);

        if (needsUpdate) {
          const iosUrl = config.get('app_store_url');
          const androidUrl = config.get('play_store_url');
          setStoreUrl(
            Platform.OS === 'ios'
              ? (iosUrl ?? null)
              : (androidUrl ?? null),
          );
          console.warn(
            '[forceUpdate] update required:',
            CURRENT_VERSION,
            '<',
            minVer,
          );
        } else {
          console.log(
            '[forceUpdate] version ok:',
            CURRENT_VERSION,
            '>=',
            minVer,
          );
        }
      }
    } catch (err) {
      console.warn('[forceUpdate] check failed:', err);
      setCheckFailed(true);
      // Don't block the user if we can't reach Supabase — we'll retry
      // on the next foreground event.
    } finally {
      setIsChecking(false);
    }
  }, []);

  // Check on mount
  useEffect(() => {
    void checkVersion();
  }, [checkVersion]);

  // Re-check when app returns to foreground (so an admin who bumps
  // min_version mid-session gets the prompt eventually)
  useEffect(() => {
    const { AppState } = require('react-native');
    const sub = AppState.addEventListener('change', (state: string) => {
      if (state === 'active') {
        void checkVersion();
      }
    });
    return () => sub.remove();
  }, [checkVersion]);

  return {
    isUpdateRequired,
    minVersion,
    storeUrl,
    isChecking,
    checkFailed,
    currentVersion: CURRENT_VERSION,
    checkVersion,
  };
});
