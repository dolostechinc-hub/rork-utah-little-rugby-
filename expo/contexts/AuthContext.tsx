import createContextHook from '@nkzw/create-context-hook';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useState, useEffect, useCallback } from 'react';

const ADMIN_PIN_KEY = 'admin_pin';
const EDITOR_PIN_KEY = 'editor_pin';
const AUTH_STATE_KEY = 'auth_state';
const AUTH_VERSION_KEY = 'auth_version';

const DEFAULT_ADMIN_PIN = '1234';
const DEFAULT_EDITOR_PIN = '';

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
  const [editorPin, setEditorPinState] = useState<string>(DEFAULT_EDITOR_PIN);
  const [pinVersion, setPinVersion] = useState<number>(1);
  const [editorPinEnabled, setEditorPinEnabled] = useState(false);

  useEffect(() => {
    const loadAuthState = async () => {
      try {
        console.log('Loading auth state...');
        
        const [storedAuthState, storedAdminPin, storedEditorPin, storedVersion] = await Promise.all([
          AsyncStorage.getItem(AUTH_STATE_KEY),
          AsyncStorage.getItem(ADMIN_PIN_KEY),
          AsyncStorage.getItem(EDITOR_PIN_KEY),
          AsyncStorage.getItem(AUTH_VERSION_KEY),
        ]);
        
        const currentVersion = storedVersion ? parseInt(storedVersion, 10) : 1;
        setPinVersion(currentVersion);
        
        if (storedAdminPin) {
          setAdminPinState(storedAdminPin);
          console.log('Loaded custom admin PIN');
        }
        
        if (storedEditorPin) {
          setEditorPinState(storedEditorPin);
          setEditorPinEnabled(true);
          console.log('Loaded editor PIN');
        }
        
        if (storedAuthState) {
          const authState: AuthState = JSON.parse(storedAuthState);
          
          if (authState.pinVersion === currentVersion) {
            setRole(authState.role);
            console.log('Restored session as:', authState.role);
          } else {
            console.log('PIN version changed, logging out user');
            await AsyncStorage.removeItem(AUTH_STATE_KEY);
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

  const loginAsAdmin = useCallback(async (pin: string): Promise<boolean> => {
    console.log('Attempting admin login...');
    if (pin === adminPin) {
      setRole('admin');
      await saveAuthState('admin', pinVersion);
      console.log('Admin login successful');
      return true;
    }
    console.log('Invalid admin PIN');
    return false;
  }, [adminPin, pinVersion, saveAuthState]);

  const loginAsEditor = useCallback(async (pin: string): Promise<boolean> => {
    console.log('Attempting editor login...');
    if (!editorPinEnabled || !editorPin) {
      console.log('Editor access not enabled');
      return false;
    }
    if (pin === editorPin) {
      setRole('editor');
      await saveAuthState('editor', pinVersion);
      console.log('Editor login successful');
      return true;
    }
    console.log('Invalid editor PIN');
    return false;
  }, [editorPin, editorPinEnabled, pinVersion, saveAuthState]);

  const login = useCallback(async (pin: string): Promise<{ success: boolean; role?: UserRole }> => {
    console.log('Attempting login with PIN...');
    
    if (pin === adminPin) {
      setRole('admin');
      await saveAuthState('admin', pinVersion);
      console.log('Admin login successful');
      return { success: true, role: 'admin' };
    }
    
    if (editorPinEnabled && editorPin && pin === editorPin) {
      setRole('editor');
      await saveAuthState('editor', pinVersion);
      console.log('Editor login successful');
      return { success: true, role: 'editor' };
    }
    
    console.log('Invalid PIN');
    return { success: false };
  }, [adminPin, editorPin, editorPinEnabled, pinVersion, saveAuthState]);

  const logout = useCallback(async () => {
    console.log('Logging out to viewer mode...');
    setRole('viewer');
    await AsyncStorage.removeItem(AUTH_STATE_KEY);
  }, []);

  const changeAdminPin = useCallback(async (currentPin: string, newPin: string): Promise<boolean> => {
    if (currentPin !== adminPin) {
      console.log('Current admin PIN incorrect');
      return false;
    }
    if (newPin.length < 4) {
      console.log('New PIN too short');
      return false;
    }
    
    const newVersion = pinVersion + 1;
    setAdminPinState(newPin);
    setPinVersion(newVersion);
    
    await Promise.all([
      AsyncStorage.setItem(ADMIN_PIN_KEY, newPin),
      AsyncStorage.setItem(AUTH_VERSION_KEY, newVersion.toString()),
    ]);
    
    await saveAuthState('admin', newVersion);
    
    console.log('Admin PIN changed, all other sessions invalidated');
    return true;
  }, [adminPin, pinVersion, saveAuthState]);

  const setEditorPin = useCallback(async (adminPinVerify: string, newEditorPin: string): Promise<boolean> => {
    if (adminPinVerify !== adminPin) {
      console.log('Admin PIN verification failed');
      return false;
    }
    
    if (!newEditorPin || newEditorPin.length < 4) {
      console.log('Editor PIN too short or empty');
      return false;
    }
    
    const newVersion = pinVersion + 1;
    setEditorPinState(newEditorPin);
    setEditorPinEnabled(true);
    setPinVersion(newVersion);
    
    await Promise.all([
      AsyncStorage.setItem(EDITOR_PIN_KEY, newEditorPin),
      AsyncStorage.setItem(AUTH_VERSION_KEY, newVersion.toString()),
    ]);
    
    await saveAuthState('admin', newVersion);
    
    console.log('Editor PIN set, all editor sessions invalidated');
    return true;
  }, [adminPin, pinVersion, saveAuthState]);

  const disableEditorAccess = useCallback(async (adminPinVerify: string): Promise<boolean> => {
    if (adminPinVerify !== adminPin) {
      console.log('Admin PIN verification failed');
      return false;
    }
    
    const newVersion = pinVersion + 1;
    setEditorPinState('');
    setEditorPinEnabled(false);
    setPinVersion(newVersion);
    
    await Promise.all([
      AsyncStorage.removeItem(EDITOR_PIN_KEY),
      AsyncStorage.setItem(AUTH_VERSION_KEY, newVersion.toString()),
    ]);
    
    await saveAuthState('admin', newVersion);
    
    console.log('Editor access disabled, all editor sessions revoked');
    return true;
  }, [adminPin, pinVersion, saveAuthState]);

  const revokeAllEditorSessions = useCallback(async (adminPinVerify: string): Promise<boolean> => {
    if (adminPinVerify !== adminPin) {
      console.log('Admin PIN verification failed');
      return false;
    }
    
    const newVersion = pinVersion + 1;
    setPinVersion(newVersion);
    
    await AsyncStorage.setItem(AUTH_VERSION_KEY, newVersion.toString());
    await saveAuthState('admin', newVersion);
    
    console.log('All editor sessions revoked');
    return true;
  }, [adminPin, pinVersion, saveAuthState]);

  const isAdmin = role === 'admin';
  const isEditor = role === 'editor';
  const isViewer = role === 'viewer';
  const canEdit = role === 'admin' || role === 'editor';

  return {
    role,
    isAdmin,
    isEditor,
    isViewer,
    canEdit,
    isLoading,
    editorPinEnabled,
    login,
    loginAsAdmin,
    loginAsEditor,
    logout,
    changeAdminPin,
    setEditorPin,
    disableEditorAccess,
    revokeAllEditorSessions,
  };
});
