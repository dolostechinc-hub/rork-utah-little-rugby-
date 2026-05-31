import Constants from 'expo-constants';

const FALLBACK_SUPABASE_URL = 'https://pfhkypuavngiidyrrnpn.supabase.co';
const FALLBACK_SUPABASE_ANON_KEY = 'sb_publishable_o6d-VXD_hzD1AYntd2_guw_dj-8ZyYX';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hashStringToHex(s: string, len: number): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xdeadbeef;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  let out = '';
  let v1 = h1 >>> 0;
  let v2 = h2 >>> 0;
  while (out.length < len) {
    out += v1.toString(16).padStart(8, '0');
    out += v2.toString(16).padStart(8, '0');
    v1 = Math.imul(v1 ^ 0x9e3779b9, 2654435761) >>> 0;
    v2 = Math.imul(v2 ^ 0x85ebca6b, 2246822519) >>> 0;
  }
  return out.slice(0, len);
}

export function coerceToUUID(input: string | null | undefined, salt: string = ''): string {
  const v = (input ?? '').trim();
  if (UUID_RE.test(v)) return v.toLowerCase();
  const seed = `${salt}::${v || 'empty'}`;
  const hex = hashStringToHex(seed, 32);
  const part1 = hex.slice(0, 8);
  const part2 = hex.slice(8, 12);
  const part3 = '4' + hex.slice(13, 16);
  const yNibble = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  const part4 = yNibble + hex.slice(17, 20);
  const part5 = hex.slice(20, 32);
  return `${part1}-${part2}-${part3}-${part4}-${part5}`;
}

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
  // Added in migration 040. Older RPCs that don't return this column will
  // produce undefined; callers should treat undefined/null as true so we
  // don't accidentally hide orgs that pre-date the column.
  is_active?: boolean | null;
}

// Polyfill-safe AbortController for React Native Hermes (iOS production).
// Hermes added AbortController in v0.12, but some production bundles still
// ship without it. We fall back to Promise.race with a timeout token so the
// network request always has an upper bound, even without AbortController.
const hasAbortController =
  typeof AbortController !== 'undefined' && typeof AbortSignal !== 'undefined';

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  if (hasAbortController) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  // Fallback: race fetch against a timeout promise
  const timeout = new Promise<never>((_resolve, reject) =>
    setTimeout(() => reject(new Error('Request timed out')), timeoutMs),
  );
  const res = await Promise.race([fetch(url, options), timeout]);
  return res as Response;
}

async function rpcPost<T>(fn: string, body: Record<string, unknown>, timeoutMs: number = 8000): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const { url, key } = getSupabaseRestConfig();
  const fullUrl = `${url}/rest/v1/rpc/${fn}`;
  const bodyStr = JSON.stringify(body);
  const headers = {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  console.log('[rpcPost] >>> REQUEST >>>');
  console.log('[rpcPost] URL:', fullUrl);
  console.log('[rpcPost] Headers:', JSON.stringify({ ...headers, apikey: key ? `${key.slice(0, 8)}...` : 'undefined', Authorization: key ? `Bearer ${key.slice(0, 8)}...` : 'undefined' }));
  console.log('[rpcPost] Body:', bodyStr);
  console.log('[rpcPost] Body type:', typeof bodyStr, '| Is stringified flat object:', bodyStr.startsWith('{') && bodyStr.endsWith('}'));
  try {
    const res = await fetchWithTimeout(fullUrl, {
      method: 'POST',
      headers,
      body: bodyStr,
    }, timeoutMs);
    const text = await res.text();
    console.log('[rpcPost] <<< RESPONSE <<<');
    console.log('[rpcPost] Status:', res.status, res.statusText);
    console.log('[rpcPost] Body (first 500 chars):', text.slice(0, 500));
    console.log('[rpcPost] Body type:', typeof text, '| Looks like array:', text.trim().startsWith('['), '| Looks like object:', text.trim().startsWith('{'));
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
    }
    try {
      const data = text ? (JSON.parse(text) as T) : (undefined as unknown as T);
      console.log('[rpcPost] Parsed data type:', Array.isArray(data) ? `array[${(data as unknown[]).length}]` : typeof data);
      return { ok: true, data };
    } catch {
      return { ok: false, error: `Invalid JSON: ${text.slice(0, 300)}` };
    }
  } catch (err) {
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
  const safeOrgId = coerceToUUID(m.orgId, 'org');
  const safeUserId = coerceToUUID(m.userId, `user::${safeOrgId}`);
  const safeId = coerceToUUID(m.id, `member::${safeOrgId}::${safeUserId}`);
  if (safeId !== m.id || safeOrgId !== m.orgId || safeUserId !== m.userId) {
    console.log('[restUpsertMember] coerced legacy non-UUID ids', {
      origId: m.id, origOrgId: m.orgId, origUserId: m.userId,
      safeId, safeOrgId, safeUserId,
    });
  }
  const r = await rpcPost<unknown>('public_upsert_org_member', {
    p_id: safeId,
    p_org_id: safeOrgId,
    p_user_id: safeUserId,
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
  const body = {
    p_code: (params.code || '').toUpperCase().trim(),
    p_user_id: params.userId,
    p_name: params.name || 'Volunteer',
    p_email: params.email || '',
  };
  console.log('[restJoinOrg] POST body to public_join_org:', JSON.stringify(body));
  const r = await rpcPost<RemoteOrg[] | RemoteOrg | null>('public_join_org', body);
  console.log('[restJoinOrg] rpcPost result — ok:', r.ok, '| data:', r.ok ? JSON.stringify(r.data).slice(0, 500) : 'N/A');
  if (!r.ok) return r;
  const row = Array.isArray(r.data) ? (r.data[0] ?? null) : (r.data ?? null);
  console.log('[restJoinOrg] extracted row:', row ? `id=${(row as RemoteOrg).id} name=${(row as RemoteOrg).name}` : 'NULL');
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
