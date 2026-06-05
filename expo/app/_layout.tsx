import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import * as Linking from 'expo-linking';
import React, { Component, useEffect, useState } from 'react';
import { Platform, View, Text, TouchableOpacity, ScrollView } from 'react-native';
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

// ---------------------------------------------------------------------------
// Error Boundary — catches render-time exceptions so a single provider throw
// doesn't crash the entire app. In production, Hermes kills the process on
// unhandled rejections AND uncaught render exceptions unless caught here.
// ---------------------------------------------------------------------------
interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  componentStack: string | null;
}

class AppErrorBoundary extends Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null, componentStack: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Surface the FULL error so it shows in `npx react-native log-ios`,
    // adb logcat, and any device console — not just a generic string.
    console.error('[ErrorBoundary] caught fatal error');
    console.error('[ErrorBoundary] message:', error?.message ?? '(no message)');
    console.error('[ErrorBoundary] name:', error?.name ?? '(no name)');
    console.error('[ErrorBoundary] stack:', error?.stack ?? '(no stack)');
    console.error('[ErrorBoundary] componentStack:', info?.componentStack ?? '(no componentStack)');
    this.setState({ componentStack: info?.componentStack ?? null });
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null, componentStack: null });
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      const { error, componentStack } = this.state;
      return (
        <View style={{ flex: 1, backgroundColor: '#FFFFFF', paddingTop: 64 }}>
          <View style={{ paddingHorizontal: 24, paddingBottom: 12 }}>
            <Text
              style={{
                fontSize: 18,
                fontWeight: '600',
                color: '#B00020',
                marginBottom: 8,
              }}
            >
              Startup error (debug)
            </Text>
            <TouchableOpacity
              onPress={this.handleReset}
              style={{
                alignSelf: 'flex-start',
                backgroundColor: '#0B7A4B',
                paddingHorizontal: 20,
                paddingVertical: 10,
                borderRadius: 8,
              }}
            >
              <Text style={{ color: '#FFFFFF', fontSize: 15, fontWeight: '600' }}>
                Try Again
              </Text>
            </TouchableOpacity>
          </View>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: 24, paddingTop: 0 }}
          >
            <Text style={styles.debugLabel}>Message</Text>
            <Text selectable style={styles.debugValue}>
              {error?.message ?? '(no message)'}
            </Text>

            <Text style={styles.debugLabel}>Name</Text>
            <Text selectable style={styles.debugValue}>
              {error?.name ?? '(no name)'}
            </Text>

            <Text style={styles.debugLabel}>Stack</Text>
            <Text selectable style={styles.debugMono}>
              {error?.stack ?? '(no stack)'}
            </Text>

            <Text style={styles.debugLabel}>Component stack</Text>
            <Text selectable style={styles.debugMono}>
              {componentStack ?? '(no component stack)'}
            </Text>
          </ScrollView>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = {
  debugLabel: {
    fontSize: 12,
    fontWeight: '700' as const,
    color: '#444444',
    marginTop: 16,
    marginBottom: 4,
    textTransform: 'uppercase' as const,
  },
  debugValue: {
    fontSize: 14,
    color: '#1A1A1A',
  },
  debugMono: {
    fontSize: 12,
    color: '#1A1A1A',
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
};

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

  // ── Global unhandled promise rejection handler ──────────────────────
  // In Hermes (production), unhandled rejections are FATAL and crash the
  // app to the home screen. This handler catches them and logs the error
  // instead, preventing the crash. JSC (dev) just shows a yellow box.
  useEffect(() => {
    const handler = (event: PromiseRejectionEvent) => {
      console.error(
        '[global] unhandled promise rejection — prevented Hermes crash:',
        event.reason instanceof Error ? event.reason.message : String(event.reason),
      );
      event.preventDefault();
    };
    // @ts-expect-error — Hermes-specific global hook; safe no-op on JSC
    if (typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('unhandledrejection', handler);
    }
    return () => {
      // @ts-expect-error
      if (typeof globalThis.removeEventListener === 'function') {
        globalThis.removeEventListener('unhandledrejection', handler);
      }
    };
  }, []);

  const handleSplashFinish = () => {
    setShowSplash(false);
  };

  if (showSplash) {
    return <CustomSplashScreen onFinish={handleSplashFinish} />;
  }

  return (
    <AppErrorBoundary>
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
    </AppErrorBoundary>
  );
}
