import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import * as Linking from 'expo-linking';
import React, { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { RegistrationProvider } from '@/contexts/RegistrationContext';
import { AuthProvider } from '@/contexts/AuthContext';
import { OrganizationProvider } from '@/contexts/OrganizationContext';
import { AgeGroupRulesProvider } from '@/contexts/AgeGroupRulesContext';
import { trpc, trpcClient } from '@/lib/trpc';
import { supabase } from '@/lib/supabase';
import CustomSplashScreen from '@/components/SplashScreen';

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

function RootLayoutNav() {
  return (
    <Stack screenOptions={{ headerBackTitle: 'Back' }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen
        name="player/[id]"
        options={{
          headerShown: true,
          title: 'Player Details',
          presentation: 'card',
        }}
      />
      <Stack.Screen name="coach/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="coach/admin" options={{ headerShown: false }} />
    </Stack>
  );
}

// Wires up the Supabase magic-link redirect on iOS / Android.
//
// NOTE: As of migration 032, the app uses OTP-only auth (email template has
// {{ .Token }}, not {{ .ConfirmationURL }}). This bridge is retained as a
// no-op safety net — if a magic-link URL ever arrives (e.g. from an older
// build or a future template change), it will still establish the session.
function useSupabaseMagicLinkBridge(): void {
  useEffect(() => {
    if (Platform.OS === 'web') {
      return;
    }

    const handleUrl = async (url: string | null | undefined) => {
      if (!url) return;
      // Magic links contain either an `access_token` fragment (legacy) or
      // a `code=` query (PKCE). Either way, exchangeCodeForSession knows
      // how to handle a full URL string.
      if (!/access_token=|[?&]code=/.test(url)) {
        return;
      }
      try {
        console.log('[auth] magic-link url received');
        const { error } = await supabase.auth.exchangeCodeForSession(url);
        if (error) {
          console.warn('[auth] exchangeCodeForSession failed:', error.message);
        } else {
          console.log('[auth] session established from magic link');
        }
      } catch (err) {
        console.warn('[auth] exchangeCodeForSession threw:', err);
      }
    };

    // Cold start: app was launched by tapping the link.
    void Linking.getInitialURL().then((url) => handleUrl(url));

    // Warm start: app was already running when the link was tapped.
    const sub = Linking.addEventListener('url', ({ url }) => {
      void handleUrl(url);
    });

    return () => {
      sub.remove();
    };
  }, []);
}

export default function RootLayout() {
  const [showSplash, setShowSplash] = useState(true);

  useSupabaseMagicLinkBridge();

  useEffect(() => {
    SplashScreen.hideAsync();
  }, []);

  const handleSplashFinish = () => {
    setShowSplash(false);
  };

  if (showSplash) {
    return <CustomSplashScreen onFinish={handleSplashFinish} />;
  }

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <AuthProvider>
            <OrganizationProvider>
              <RegistrationProvider>
                <AgeGroupRulesProvider>
                  <RootLayoutNav />
                </AgeGroupRulesProvider>
              </RegistrationProvider>
            </OrganizationProvider>
          </AuthProvider>
        </GestureHandlerRootView>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
