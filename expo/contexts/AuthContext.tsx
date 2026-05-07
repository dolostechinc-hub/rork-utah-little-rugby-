import createContextHook from '@nkzw/create-context-hook';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Linking from 'expo-linking';
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  EditorSession,
  clearEditorSession,
  getEditorSession,
  issueEditorPin as issueEditorPinRPC,
  loadEditorSession,
  redeemEditorPin as redeemEditorPinRPC,
  revokeAllEditorAccess as revokeAllEditorAccessRPC,
  revokeEditorPin as revokeEditorPinRPC,
  subscribeEditorSession,
} from '@/lib/editorSession';
import { supabase } from '@/lib/supabase';
import { isAppAdmin as isAppAdminRPC } from '@/lib/appAdmin';

const ADMIN_PIN_KEY = 'admin_pin';
const AUTH_STATE_KEY = 'auth_state';
const AUTH_VERSION_KEY = 'auth_version';

const DEFAULT_ADMIN_PIN = '1234';

export type UserRole = 'admin' | 'editor' | 'viewer';

interface AuthState {
  role: UserRole;
  authenticatedAt: string | null;
  pinVersion: number;
}

export const [AuthProvider, useAuth] = createContextHook(() => {
  const [role, setRole] = useState<UserRole>('viewer');
  const [isLoading, setIsLoading] = useState(true);
  const [adminPin, setAdminPinState] = useState<string>(DEFAULT_ADMIN_PIN);
  const [pinVersion, setPinVersion] = useState<number>(1);
  const [editorSession, setEditorSessionState] = useState<EditorSession | null>(null);
  const [eventLockedForEditors, setEventLockedForEditorsState] = useState<boolean>(false);
  const [isOrgOwner, setIsOrgOwnerState] = useState<boolean>(false);
  const isOrgOwnerRef = useRef<boolean>(false);

  // ---------------------------------------------------------------------------
  // Supabase auth-backed identity (added in migration 032).
  //
  // `authUserId` and `authEmail` come from supabase.auth.getSession() and
  // stay in sync via onAuthStateChange. `isAppAdmin` is fetched from the
  // server whenever auth state changes (server-side check, never trusted
  // from the client).
  // ---------------------------------------------------------------------------
  const [authUserId, setAuthUserId] = useState<string | null>(null);
  const [authEmail, setAuthEmail] = useState<string | null>(null);
  const [isAppAdmin, setIsAppAdmin] = useState<boolean>(false);
  const [isAuthLoaded, setIsAuthLoaded] = useState<boolean>(false);
  const [isOrgAdminViaAuth, setIsOrgAdminViaAuthState] = useState<boolean>(false);
  // Currently a no-op / placeholder. RegistrationContext flips this true
  // when `auth.uid()` matches an org_members row with role admin/owner
  // for the active org. Defaulting to false keeps the existing behaviour
  // unchanged for everyone who's not signed in.
  const setIsOrgAdminViaAuth = useCallback((v: boolean) => {
    setIsOrgAdminViaAuthState((prev) => (prev === v ? prev : v));
  }, []);

  const refreshAppAdminStatus = useCallback(async () => {
    try {
      const yes = await isAppAdminRPC();
      setIsAppAdmin(yes);
    } catch (err) {
      console.warn('[auth] isAppAdmin check failed:', err);
      setIsAppAdmin(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const applySession = async (
      session: { user: { id: string; email?: string | null } } | null,
    ) => {
      if (cancelled) return;
      const uid = session?.user?.id ?? null;
      const email = session?.user?.email ?? null;
      setAuthUserId(uid);
      setAuthEmail(email);
      if (uid) {
        await refreshAppAdminStatus();
      } else {
        setIsAppAdmin(false);
      }
      setIsAuthLoaded(true);
    };

    void supabase.auth.getSession().then(({ data }) => applySession(data?.session ?? null));

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      console.log('[auth] supabase auth event:', event);
      void applySession(session);
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [refreshAppAdminStatus]);

  const signInWithEmail = useCallback(async (email: string): Promise<{ ok: true } | { ok: false; error: string }> => {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !trimmed.includes('@')) {
      return { ok: false, error: 'Enter a valid email address.' };
    }
    try {
      const redirectTo = Linking.createURL('/auth-callback');
      // Logged so you can confirm in the dev terminal which redirect URL
      // got sent to Supabase. The URL must be whitelisted under
      // Authentication → URL Configuration → Redirect URLs in the
      // Supabase dashboard, otherwise Supabase silently substitutes the
      // project's Site URL (e.g. http://localhost:3000) and the magic
      // link will not return you to the app.
      console.log('[auth] sending magic link', { email: trimmed, redirectTo });
      const { error } = await supabase.auth.signInWithOtp({
        email: trimmed,
        options: {
          emailRedirectTo: redirectTo,
          shouldCreateUser: true,
        },
      });
      if (error) {
        return { ok: false, error: error.message };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message || 'Could not send magic link' };
    }
  }, []);

  const verifyEmailOtp = useCallback(
    async (email: string, token: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      const trimmedEmail = email.trim().toLowerCase();
      // Supabase's email-OTP length is configurable per project (default 6,
      // many projects use 8). Accept anything between 4 and 10 digits and
      // let the server reject if the value is wrong.
      const trimmedToken = token.replace(/\D/g, '').slice(0, 10);
      if (!trimmedEmail.includes('@')) {
        return { ok: false, error: 'Enter a valid email address.' };
      }
      if (trimmedToken.length < 4) {
        return { ok: false, error: 'Enter the code from the email.' };
      }
      try {
        // type 'email' matches what Supabase issues for magic-link / OTP
        // emails. Successful verification establishes a session in the
        // local Supabase client, which our onAuthStateChange listener
        // picks up and uses to refresh authUserId / isAppAdmin.
        const { error } = await supabase.auth.verifyOtp({
          email: trimmedEmail,
          token: trimmedToken,
          type: 'email',
        });
        if (error) {
          return { ok: false, error: error.message };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message || 'Could not verify code' };
      }
    },
    [],
  );

  const signOut = useCallback(async (): Promise<void> => {
    try {
      await supabase.auth.signOut();
    } catch (err) {
      console.warn('[auth] signOut failed:', err);
    }
    setAuthUserId(null);
    setAuthEmail(null);
    setIsAppAdmin(false);
  }, []);

  useEffect(() => {
    const unsub = subscribeEditorSession((s) => {
      setEditorSessionState(s);
      if (!s && role === 'editor') {
        console.log('Editor session lost, dropping to viewer');
        setRole('viewer');
        void AsyncStorage.removeItem(AUTH_STATE_KEY);
      }
    });
    return () => unsub();
  }, [role]);

  // While in editor mode, periodically re-validate the session against the
  // server so that admin actions like "Disable Editor Access" or rotating
  // the editor PIN take effect on other devices without requiring a manual
  // app reload.
  useEffect(() => {
    if (role !== 'editor') return;
    let cancelled = false;
    const tick = async () => {
      const session = await loadEditorSession();
      if (cancelled) return;
      if (!session) {
        console.log('[auth] editor session expired/revoked - dropping to viewer');
        setRole('viewer');
        await AsyncStorage.removeItem(AUTH_STATE_KEY);
      }
    };
    const interval = setInterval(() => {
      void tick();
    }, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [role]);

  useEffect(() => {
    const loadAuthState = async () => {
      try {
        console.log('Loading auth state...');
        const [storedAuthState, storedAdminPin, storedVersion] = await Promise.all([
          AsyncStorage.getItem(AUTH_STATE_KEY),
          AsyncStorage.getItem(ADMIN_PIN_KEY),
          AsyncStorage.getItem(AUTH_VERSION_KEY),
        ]);

        const currentVersion = storedVersion ? parseInt(storedVersion, 10) : 1;
        setPinVersion(currentVersion);

        if (storedAdminPin) setAdminPinState(storedAdminPin);

        const session = await loadEditorSession();

        if (storedAuthState) {
          const authState: AuthState = JSON.parse(storedAuthState);
          if (authState.pinVersion !== currentVersion) {
            await AsyncStorage.removeItem(AUTH_STATE_KEY);
          } else if (authState.role === 'editor') {
            if (session) {
              setRole('editor');
            } else {
              console.log('Stored editor session invalid, dropping to viewer');
              await AsyncStorage.removeItem(AUTH_STATE_KEY);
            }
          } else {
            setRole(authState.role);
          }
        }
      } catch (error) {
        console.error('Failed to load auth state:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadAuthState();
  }, []);

  const saveAuthState = useCallback(async (newRole: UserRole, version: number) => {
    const authState: AuthState = {
      role: newRole,
      authenticatedAt: new Date().toISOString(),
      pinVersion: version,
    };
    await AsyncStorage.setItem(AUTH_STATE_KEY, JSON.stringify(authState));
  }, []);

  const loginAsAdmin = useCallback(
    async (pin: string): Promise<boolean> => {
      if (!isOrgOwnerRef.current) {
        console.log('[auth] admin login blocked - current device is not the owner of this organization');
        return false;
      }
      if (pin === adminPin) {
        setRole('admin');
        await saveAuthState('admin', pinVersion);
        return true;
      }
      return false;
    },
    [adminPin, pinVersion, saveAuthState],
  );

  const loginAsEditor = useCallback(
    async (orgId: string, pin: string, deviceLabel?: string): Promise<boolean> => {
      try {
        await redeemEditorPinRPC(orgId, pin, deviceLabel);
        setRole('editor');
        await saveAuthState('editor', pinVersion);
        return true;
      } catch (err) {
        console.log('Editor login failed:', (err as Error).message);
        return false;
      }
    },
    [pinVersion, saveAuthState],
  );

  const login = useCallback(
    async (
      pin: string,
      orgId?: string,
      volunteerName?: string,
    ): Promise<{ success: boolean; role?: UserRole; error?: string }> => {
      // Always try editor PIN first when an org is selected, so editors
      // are never accidentally promoted to admin (e.g. PIN collisions or
      // someone sharing the admin PIN as an editor PIN).
      if (orgId) {
        try {
          await redeemEditorPinRPC(orgId, pin, volunteerName);
          setRole('editor');
          await saveAuthState('editor', pinVersion);
          return { success: true, role: 'editor' };
        } catch (err) {
          console.log('Editor PIN check failed, trying admin PIN:', (err as Error).message);
        }
      }
      if (pin === adminPin) {
        if (!isOrgOwnerRef.current) {
          console.log('[auth] admin PIN matched but device is not org owner - refusing admin login');
          return {
            success: false,
            error: 'Only the admin who created this organization can unlock admin access on this device. Use the Editor PIN instead.',
          };
        }
        setRole('admin');
        await saveAuthState('admin', pinVersion);
        return { success: true, role: 'admin' };
      }
      return { success: false, error: 'Invalid PIN' };
    },
    [adminPin, pinVersion, saveAuthState],
  );

  const logout = useCallback(async () => {
    setRole('viewer');
    await AsyncStorage.removeItem(AUTH_STATE_KEY);
    await clearEditorSession();
  }, []);

  const changeAdminPin = useCallback(
    async (currentPin: string, newPin: string): Promise<boolean> => {
      if (currentPin !== adminPin) return false;
      if (newPin.length < 4) return false;

      const newVersion = pinVersion + 1;
      setAdminPinState(newPin);
      setPinVersion(newVersion);

      await Promise.all([
        AsyncStorage.setItem(ADMIN_PIN_KEY, newPin),
        AsyncStorage.setItem(AUTH_VERSION_KEY, newVersion.toString()),
      ]);

      await saveAuthState('admin', newVersion);
      return true;
    },
    [adminPin, pinVersion, saveAuthState],
  );

  const issueEditorPin = useCallback(
    async (
      orgId: string,
      opts?: { expiresInMinutes?: number; label?: string; adminUserId?: string; customPin?: string },
    ): Promise<{ pin: string; pinId: string; expiresAt: string }> => {
      return await issueEditorPinRPC(orgId, opts);
    },
    [],
  );

  const revokeEditorPin = useCallback(
    async (pinId: string, adminUserId?: string): Promise<void> => {
      await revokeEditorPinRPC(pinId, adminUserId);
    },
    [],
  );

  const revalidateEditorSession = useCallback(async (): Promise<boolean> => {
    if (role !== 'editor') return true;
    const session = await loadEditorSession();
    if (!session) {
      console.log('[auth] editor session was revoked, dropping to viewer');
      setRole('viewer');
      await AsyncStorage.removeItem(AUTH_STATE_KEY);
      return false;
    }
    return true;
  }, [role]);

  const revokeAllEditorAccess = useCallback(async (orgId: string, adminUserId?: string): Promise<void> => {
    await revokeAllEditorAccessRPC(orgId, adminUserId);
    if (role === 'editor') {
      setRole('viewer');
      await AsyncStorage.removeItem(AUTH_STATE_KEY);
    }
  }, [role]);

  const setEventLockedForEditors = useCallback((locked: boolean) => {
    setEventLockedForEditorsState((prev) => {
      if (prev !== locked) {
        console.log('[auth] eventLockedForEditors ->', locked);
      }
      return locked;
    });
  }, []);

  const setIsOrgOwner = useCallback((v: boolean) => {
    isOrgOwnerRef.current = v;
    setIsOrgOwnerState((prev) => (prev === v ? prev : v));
  }, []);

  // Used right after the device creates a brand-new org. The creator
  // is implicitly the admin/owner, so we promote the role without
  // requiring them to type the admin PIN.
  const grantAdminToOwner = useCallback(async () => {
    isOrgOwnerRef.current = true;
    setIsOrgOwnerState(true);
    setRole('admin');
    await saveAuthState('admin', pinVersion);
  }, [pinVersion, saveAuthState]);

  // If we lose org-owner status (e.g. switched to a joined org), drop
  // any persisted admin role on this device immediately so editors who
  // join from another org can't carry admin power across orgs.
  useEffect(() => {
    if (!isOrgOwner && role === 'admin') {
      console.log('[auth] dropping admin role - not org owner of current org');
      setRole('viewer');
      void AsyncStorage.removeItem(AUTH_STATE_KEY);
    }
  }, [isOrgOwner, role]);

  // After migration 032, admin can come from three independent sources:
  //   1. Signed in + the auth user is in `app_admins` (league admin).
  //   2. Signed in + auth user is an admin/owner of the current org via
  //      org_members.auth_uid (set by RegistrationContext).
  //   3. The legacy device-bound owner check used by every pre-auth org
  //      whose creator hasn't signed in yet.
  // The PIN-based `role === 'admin'` flow is still required for path 3
  // (it's how the device-owner unlocks admin UI today). For paths 1 & 2,
  // a real auth.uid() is sufficient and we don't require the PIN at all.
  //
  // In development builds (__DEV__ === true) we additionally force-grant
  // admin so the maintainer can navigate the whole app without going
  // through the email sign-in flow on every reinstall. Metro/Expo set
  // __DEV__ to false in production / App Store / TestFlight builds, so
  // this has zero effect on shipped binaries.
  const isAuthAdmin = !!authUserId && (isAppAdmin || isOrgAdminViaAuth);
  const isLegacyAdmin = role === 'admin' && isOrgOwner;
  const isAdmin = __DEV__ || isAuthAdmin || isLegacyAdmin;
  const isEditor = role === 'editor' && !!getEditorSession();
  const isViewer = !isAdmin && !isEditor;
  // Editors lose write access when the admin flips the event to view-only.
  // Admins always retain write access so they can flip it back.
  const canEdit = isAdmin || (isEditor && !eventLockedForEditors);

  return {
    role,
    isAdmin,
    isAuthAdmin,
    isLegacyAdmin,
    isOrgOwner,
    setIsOrgOwner,
    grantAdminToOwner,
    isEditor,
    isViewer,
    canEdit,
    isLoading,
    editorSession,
    login,
    loginAsAdmin,
    loginAsEditor,
    logout,
    changeAdminPin,
    issueEditorPin,
    revokeEditorPin,
    revokeAllEditorAccess,
    revalidateEditorSession,
    eventLockedForEditors,
    setEventLockedForEditors,
    // Auth-backed identity (migration 032)
    authUserId,
    authEmail,
    isAppAdmin,
    isAuthLoaded,
    setIsOrgAdminViaAuth,
    refreshAppAdminStatus,
    signInWithEmail,
    verifyEmailOtp,
    signOut,
  };
});
