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

export interface LoadEditorSessionOptions {
  /** Skip the remote validation round-trip — use the locally-cached session
   *  as long as it hasn't expired. Defaults to false (validate remotely). */
  validateRemote?: boolean;
  /** Abort the remote validation after this many ms. Defaults to 8000.
   *  Only used when validateRemote is true. */
  timeoutMs?: number;
}

export async function loadEditorSession(
  opts: LoadEditorSessionOptions = {},
): Promise<EditorSession | null> {
  const validateRemote = opts.validateRemote ?? true;
  const timeoutMs = opts.timeoutMs ?? 8000;

  try {
    const raw = await AsyncStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as EditorSession;
    if (!parsed?.token || !parsed.expiresAt) return null;
    if (new Date(parsed.expiresAt).getTime() <= Date.now()) {
      await AsyncStorage.removeItem(SESSION_KEY);
      return null;
    }

    if (!validateRemote) {
      // Cold-start fast path: trust the locally-cached session if it hasn't
      // expired. A background validation will run shortly after.
      memorySession = parsed;
      notify();
      return memorySession;
    }

    // Remote validation with timeout — network errors should NOT invalidate
    // a locally-valid session (they are transient, not a revocation).
    let data: { valid?: boolean; org_id?: string; expires_at?: string } | null = null;
    let rpcError: string | null = null;
    let isNetworkError = false;

    try {
      const rpcPromise = supabase.rpc('validate_editor_session', {
        p_token: parsed.token,
      });

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), timeoutMs),
      );

      const result = await Promise.race([rpcPromise, timeoutPromise]);

      if (result.error) {
        rpcError = result.error.message;
      } else {
        data = result.data as typeof data;
      }
    } catch (fetchErr) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      // Network-level error (offline, timeout, DNS) — keep the local session.
      if (/timeout|network|fetch|failed to fetch/i.test(msg)) {
        isNetworkError = true;
        console.warn('[editorSession] remote validation unreachable — keeping local session');
      } else {
        rpcError = msg;
      }
    }

    if (isNetworkError) {
      memorySession = parsed;
      notify();
      return memorySession;
    }

    if (rpcError) {
      console.warn('[editorSession] validate_editor_session RPC error:', rpcError);
      // Treat unknown RPC errors as transient and keep the local session.
      memorySession = parsed;
      notify();
      return memorySession;
    }

    if (!data?.valid) {
      // Server explicitly said the session is revoked/expired — clear it.
      console.log('[editorSession] server says session invalid — clearing');
      await AsyncStorage.removeItem(SESSION_KEY);
      memorySession = null;
      notify();
      return null;
    }

    memorySession = {
      token: parsed.token,
      orgId: data.org_id ?? parsed.orgId,
      expiresAt: data.expires_at ?? parsed.expiresAt,
    };
    notify();
    return memorySession;
  } catch (err) {
    console.warn('[editorSession] loadEditorSession error:', err);
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
  opts?: { expiresInMinutes?: number; label?: string; adminUserId?: string; customPin?: string },
): Promise<{ pin: string; pinId: string; expiresAt: string }> {
  const customPin = opts?.customPin?.trim();
  const payload: Record<string, unknown> = {
    p_org_id: orgId,
    p_expires_in_minutes: opts?.expiresInMinutes ?? 480,
    p_label: opts?.label ?? null,
    p_admin_user_id: opts?.adminUserId ?? null,
  };
  if (customPin && customPin.length > 0) {
    payload.p_custom_pin = customPin;
  }
  const { data, error } = await supabase.rpc('issue_editor_pin', payload);
  if (error) {
    if (customPin && /p_custom_pin|function .* does not exist/i.test(error.message)) {
      throw new Error(
        'Custom PINs require a database update. Ask the admin to run migration 022_custom_editor_pin.sql, or use an auto-generated PIN for now.',
      );
    }
    throw new Error(error.message);
  }
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

export interface ActiveEditorSession {
  id: string;
  device_label: string | null;
  pin_label: string | null;
  issued_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export async function listActiveEditorSessions(
  orgId: string,
  adminUserId?: string,
): Promise<ActiveEditorSession[]> {
  const { data, error } = await supabase.rpc('list_editor_sessions', {
    p_org_id: orgId,
    p_admin_user_id: adminUserId ?? null,
  });
  if (error) {
    if (/function .* does not exist/i.test(error.message)) {
      throw new Error(
        'Active editors view requires a database update. Ask the admin to run migration 023_editor_sessions_admin.sql.',
      );
    }
    throw new Error(error.message);
  }
  return (data ?? []) as ActiveEditorSession[];
}

export async function revokeEditorSession(
  sessionId: string,
  adminUserId?: string,
): Promise<void> {
  const { data, error } = await supabase.rpc('revoke_editor_session', {
    p_session_id: sessionId,
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
