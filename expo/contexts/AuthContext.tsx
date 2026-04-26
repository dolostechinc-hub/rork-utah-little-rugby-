import createContextHook from '@nkzw/create-context-hook';
import AsyncStorage from '@react-native-async-storage/async-storage';
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
    ): Promise<{ success: boolean; role?: UserRole; error?: string }> => {
      // Always try editor PIN first when an org is selected, so editors
      // are never accidentally promoted to admin (e.g. PIN collisions or
      // someone sharing the admin PIN as an editor PIN).
      if (orgId) {
        try {
          await redeemEditorPinRPC(orgId, pin);
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
      opts?: { expiresInMinutes?: number; label?: string; adminUserId?: string },
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

  const isAdmin = role === 'admin' && isOrgOwner;
  const isEditor = role === 'editor' && !!getEditorSession();
  const isViewer = !isAdmin && !isEditor;
  // Editors lose write access when the admin flips the event to view-only.
  // Admins always retain write access so they can flip it back.
  const canEdit = isAdmin || (isEditor && !eventLockedForEditors);

  return {
    role,
    isAdmin,
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
  };
});
