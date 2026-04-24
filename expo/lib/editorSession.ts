import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '@/lib/supabase';

const SESSION_KEY = 'editor_session_v1';

export interface EditorSession {
  token: string;
  orgId: string;
  expiresAt: string;
}

let memorySession: EditorSession | null = null;
const listeners = new Set<(s: EditorSession | null) => void>();

function notify() {
  listeners.forEach((l) => l(memorySession));
}

export function subscribeEditorSession(cb: (s: EditorSession | null) => void): () => void {
  listeners.add(cb);
  cb(memorySession);
  return () => {
    listeners.delete(cb);
  };
}

export function getEditorSession(): EditorSession | null {
  if (!memorySession) return null;
  if (new Date(memorySession.expiresAt).getTime() <= Date.now()) {
    memorySession = null;
    void AsyncStorage.removeItem(SESSION_KEY);
    notify();
    return null;
  }
  return memorySession;
}

export async function loadEditorSession(): Promise<EditorSession | null> {
  try {
    const raw = await AsyncStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as EditorSession;
    if (!parsed?.token || !parsed.expiresAt) return null;
    if (new Date(parsed.expiresAt).getTime() <= Date.now()) {
      await AsyncStorage.removeItem(SESSION_KEY);
      return null;
    }
    const { data, error } = await supabase.rpc('validate_editor_session', {
      p_token: parsed.token,
    });
    if (error) {
      console.warn('validate_editor_session failed:', error.message);
      return null;
    }
    const res = data as { valid?: boolean; org_id?: string; expires_at?: string } | null;
    if (!res?.valid) {
      await AsyncStorage.removeItem(SESSION_KEY);
      return null;
    }
    memorySession = {
      token: parsed.token,
      orgId: res.org_id ?? parsed.orgId,
      expiresAt: res.expires_at ?? parsed.expiresAt,
    };
    notify();
    return memorySession;
  } catch (err) {
    console.warn('loadEditorSession error:', err);
    return null;
  }
}

export async function setEditorSession(session: EditorSession): Promise<void> {
  memorySession = session;
  await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(session));
  notify();
}

export async function clearEditorSession(): Promise<void> {
  memorySession = null;
  await AsyncStorage.removeItem(SESSION_KEY);
  notify();
}

export async function redeemEditorPin(
  orgId: string,
  pin: string,
  deviceLabel?: string,
): Promise<EditorSession> {
  const { data, error } = await supabase.rpc('redeem_editor_pin', {
    p_org_id: orgId,
    p_pin: pin,
    p_device_label: deviceLabel ?? null,
  });
  if (error) throw new Error(error.message);
  const res = data as { error?: string; token?: string; expires_at?: string; org_id?: string };
  if (res?.error || !res?.token) {
    throw new Error(res?.error ?? 'Invalid PIN');
  }
  const session: EditorSession = {
    token: res.token,
    orgId: res.org_id ?? orgId,
    expiresAt: res.expires_at ?? new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
  };
  await setEditorSession(session);
  return session;
}

export async function issueEditorPin(
  orgId: string,
  opts?: { expiresInMinutes?: number; label?: string; adminUserId?: string },
): Promise<{ pin: string; pinId: string; expiresAt: string }> {
  const { data, error } = await supabase.rpc('issue_editor_pin', {
    p_org_id: orgId,
    p_expires_in_minutes: opts?.expiresInMinutes ?? 480,
    p_label: opts?.label ?? null,
    p_admin_user_id: opts?.adminUserId ?? null,
  });
  if (error) throw new Error(error.message);
  const res = data as { error?: string; pin?: string; pin_id?: string; expires_at?: string };
  if (res?.error || !res?.pin) throw new Error(res?.error ?? 'Could not issue PIN');
  return { pin: res.pin, pinId: res.pin_id ?? '', expiresAt: res.expires_at ?? '' };
}

export async function revokeAllEditorAccess(
  orgId: string,
  adminUserId?: string,
): Promise<void> {
  const { data, error } = await supabase.rpc('revoke_all_editor_access', {
    p_org_id: orgId,
    p_admin_user_id: adminUserId ?? null,
  });
  if (error) throw new Error(error.message);
  const res = data as { error?: string };
  if (res?.error) throw new Error(res.error);
  await clearEditorSession();
}

export async function revokeEditorPin(
  pinId: string,
  adminUserId?: string,
): Promise<void> {
  const { data, error } = await supabase.rpc('revoke_editor_pin', {
    p_pin_id: pinId,
    p_admin_user_id: adminUserId ?? null,
  });
  if (error) throw new Error(error.message);
  const res = data as { error?: string };
  if (res?.error) throw new Error(res.error);
}

export async function listEditorPins(orgId: string) {
  const { data, error } = await supabase
    .from('editor_pins')
    .select('id, label, created_at, expires_at, revoked_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}
