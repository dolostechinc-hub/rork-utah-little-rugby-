import Constants from 'expo-constants';

const FALLBACK_SUPABASE_URL = 'https://pfhkypuavngiidyrrnpn.supabase.co';
const FALLBACK_SUPABASE_ANON_KEY = 'sb_publishable_o6d-VXD_hzD1AYntd2_guw_dj-8ZyYX';

export function getSupabaseRestConfig(): { url: string; key: string } {
  const url =
    process.env.EXPO_PUBLIC_SUPABASE_URL ??
    (Constants.expoConfig?.extra?.EXPO_PUBLIC_SUPABASE_URL as string | undefined) ??
    FALLBACK_SUPABASE_URL;
  const key =
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
    (Constants.expoConfig?.extra?.EXPO_PUBLIC_SUPABASE_ANON_KEY as string | undefined) ??
    FALLBACK_SUPABASE_ANON_KEY;
  return { url, key };
}

export interface RemoteOrg {
  id: string;
  name: string;
  code: string;
  logo_uri: string | null;
  primary_color: string | null;
  owner_id: string;
  created_at: string;
  expires_at: string | null;
}

async function rpcPost<T>(fn: string, body: Record<string, unknown>, timeoutMs: number = 8000): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const { url, key } = getSupabaseRestConfig();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(t);
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
    }
    try {
      const data = text ? (JSON.parse(text) as T) : (undefined as unknown as T);
      return { ok: true, data };
    } catch {
      return { ok: false, error: `Invalid JSON: ${text.slice(0, 300)}` };
    }
  } catch (err) {
    clearTimeout(t);
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

export async function restLookupOrgByCode(code: string): Promise<{ ok: true; org: RemoteOrg | null } | { ok: false; error: string }> {
  const r = await rpcPost<RemoteOrg[] | RemoteOrg | null>('public_lookup_org_by_code', {
    p_code: (code || '').toUpperCase().trim(),
  });
  if (!r.ok) return r;
  const row = Array.isArray(r.data) ? (r.data[0] ?? null) : (r.data ?? null);
  return { ok: true, org: row };
}

export interface UpsertOrgInput {
  id: string;
  name: string;
  code: string;
  logoUri: string | null;
  primaryColor: string | null;
  ownerId: string;
  expiresAt: string | null;
  createdAt: string;
}

export async function restUpsertOrg(org: UpsertOrgInput): Promise<{ ok: true; org: RemoteOrg } | { ok: false; error: string }> {
  const r = await rpcPost<RemoteOrg | RemoteOrg[] | null>('public_upsert_organization', {
    p_id: org.id,
    p_name: org.name,
    p_code: (org.code || '').toUpperCase().trim(),
    p_logo_uri: org.logoUri,
    p_primary_color: org.primaryColor ?? '#0B7A4B',
    p_owner_id: org.ownerId,
    p_expires_at: org.expiresAt,
    p_created_at: org.createdAt,
  });
  if (!r.ok) return r;
  const row = Array.isArray(r.data) ? (r.data[0] ?? null) : (r.data ?? null);
  if (!row) return { ok: false, error: 'Empty response from upsert RPC' };
  return { ok: true, org: row };
}

export interface UpsertMemberInput {
  id: string;
  orgId: string;
  userId: string;
  role: string;
  email: string;
  name: string;
  joinedAt: string;
}

export async function restUpsertMember(m: UpsertMemberInput): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await rpcPost<unknown>('public_upsert_org_member', {
    p_id: m.id,
    p_org_id: m.orgId,
    p_user_id: m.userId,
    p_role: m.role,
    p_email: m.email ?? '',
    p_name: m.name ?? '',
    p_joined_at: m.joinedAt,
  });
  if (!r.ok) return r;
  return { ok: true };
}

export async function restJoinOrg(params: {
  code: string;
  userId: string;
  name: string;
  email: string;
}): Promise<{ ok: true; org: RemoteOrg | null } | { ok: false; error: string }> {
  const r = await rpcPost<RemoteOrg[] | RemoteOrg | null>('public_join_org', {
    p_code: (params.code || '').toUpperCase().trim(),
    p_user_id: params.userId,
    p_name: params.name || 'Volunteer',
    p_email: params.email || '',
  });
  if (!r.ok) return r;
  const row = Array.isArray(r.data) ? (r.data[0] ?? null) : (r.data ?? null);
  return { ok: true, org: row };
}

export async function restUpsertOrgWithRetry(
  org: UpsertOrgInput,
  opts: { attempts?: number; baseDelayMs?: number } = {},
): Promise<{ ok: true; org: RemoteOrg } | { ok: false; error: string; attempts: number }> {
  const attempts = opts.attempts ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 700;
  let lastErr = 'unknown';
  for (let i = 1; i <= attempts; i++) {
    const res = await restUpsertOrg(org);
    if (res.ok) {
      const verify = await restLookupOrgByCode(org.code);
      if (verify.ok && verify.org && verify.org.id === res.org.id) {
        return { ok: true, org: res.org };
      }
      lastErr = verify.ok ? 'upsert ok but verify returned no row' : verify.error;
    } else {
      lastErr = res.error;
    }
    console.log('[orgCloudSync] upsert attempt', i, 'failed:', lastErr);
    if (i < attempts) {
      await new Promise((r) => setTimeout(r, baseDelayMs * i));
    }
  }
  return { ok: false, error: lastErr, attempts };
}
