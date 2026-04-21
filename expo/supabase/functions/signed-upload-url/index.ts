// Edge Function: signed-upload-url
// Validates an editor session token (or an authenticated admin JWT) and
// returns a short-lived signed upload URL for the `player_photos` bucket.
//
// POST body: { orgId: string, playerId: string, sessionToken?: string, ext?: string }
// Response:  { path, token, signedUrl, publicUrl }
//
// Deploy: `supabase functions deploy signed-upload-url --no-verify-jwt`
// (we accept either the editor session token or the Supabase anon key.)

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BUCKET = 'player_photos';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-editor-session',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const orgId: string | undefined = payload?.orgId;
  const playerId: string | undefined = payload?.playerId;
  const ext: string = (payload?.ext ?? 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'jpg';
  const sessionToken: string | undefined =
    payload?.sessionToken ?? req.headers.get('x-editor-session') ?? undefined;

  if (!orgId || !playerId) {
    return json({ error: 'orgId and playerId are required' }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });

  // Authorize: either a valid editor session for the org, or an admin JWT.
  let authorized = false;

  if (sessionToken) {
    const tokenHash = await sha256Hex(sessionToken);
    const { data, error } = await admin
      .from('editor_sessions')
      .select('org_id, expires_at, revoked_at')
      .eq('token_hash', tokenHash)
      .maybeSingle();

    if (error) {
      console.error('session lookup error', error);
    }
    if (
      data &&
      data.org_id === orgId &&
      data.revoked_at === null &&
      new Date(data.expires_at).getTime() > Date.now()
    ) {
      authorized = true;
      await admin
        .from('editor_sessions')
        .update({ last_used_at: new Date().toISOString() })
        .eq('token_hash', tokenHash);
    }
  }

  if (!authorized) {
    const authHeader = req.headers.get('Authorization') ?? '';
    const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (jwt && jwt !== Deno.env.get('SUPABASE_ANON_KEY')) {
      const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
        auth: { persistSession: false },
      });
      const { data: userRes } = await userClient.auth.getUser();
      if (userRes?.user) {
        const { data: memberRow } = await admin
          .from('org_members')
          .select('role')
          .eq('org_id', orgId)
          .eq('user_id', userRes.user.id)
          .maybeSingle();
        if (memberRow && ['owner', 'admin'].includes(memberRow.role)) {
          authorized = true;
        }
      }
    }
  }

  if (!authorized) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const path = `${orgId}/${playerId}-${Date.now()}.${ext}`;

  const { data, error } = await admin.storage
    .from(BUCKET)
    .createSignedUploadUrl(path);

  if (error || !data) {
    console.error('createSignedUploadUrl error', error);
    return json({ error: error?.message ?? 'Could not create signed URL' }, 500);
  }

  const { data: publicData } = admin.storage.from(BUCKET).getPublicUrl(path);

  return json({
    path: data.path,
    token: data.token,
    signedUrl: data.signedUrl,
    publicUrl: publicData.publicUrl,
  });
});
