import { supabase } from '@/lib/supabase';

export interface AppAdmin {
  auth_uid: string;
  email: string;
  added_by: string | null;
  added_at: string;
}

const SCHEMA_OUT_OF_DATE_HINT =
  'League admin features require a database update. Ask the project owner to run migration 032_supabase_auth_admins.sql.';

function looksLikeMissingFunction(message: string): boolean {
  return /function .* does not exist/i.test(message);
}

export async function isAppAdmin(): Promise<boolean> {
  const { data, error } = await supabase.rpc('is_app_admin', { p_uid: null });
  if (error) {
    if (looksLikeMissingFunction(error.message)) {
      // Function not deployed yet -- treat as "not a league admin" so the
      // rest of the app keeps working pre-migration.
      return false;
    }
    console.warn('[appAdmin] is_app_admin failed:', error.message);
    return false;
  }
  return data === true;
}

export async function listAppAdmins(): Promise<AppAdmin[]> {
  const { data, error } = await supabase.rpc('list_app_admins');
  if (error) {
    if (looksLikeMissingFunction(error.message)) {
      throw new Error(SCHEMA_OUT_OF_DATE_HINT);
    }
    if (/Unauthorized/i.test(error.message)) {
      // Caller isn't a league admin. Surface as an empty list rather
      // than an error so the UI can render a friendly empty state.
      return [];
    }
    throw new Error(error.message);
  }
  return (data ?? []) as AppAdmin[];
}

export async function grantAppAdmin(
  email: string,
): Promise<{ authUid: string }> {
  const { data, error } = await supabase.rpc('grant_app_admin', {
    p_email: email,
  });
  if (error) {
    if (looksLikeMissingFunction(error.message)) {
      throw new Error(SCHEMA_OUT_OF_DATE_HINT);
    }
    throw new Error(error.message);
  }
  const res = data as { error?: string; ok?: boolean; auth_uid?: string };
  if (res?.error || !res?.ok) {
    throw new Error(res?.error ?? 'Could not grant league admin');
  }
  return { authUid: res.auth_uid ?? '' };
}

export async function revokeAppAdmin(authUid: string): Promise<{ changed: boolean }> {
  const { data, error } = await supabase.rpc('revoke_app_admin', {
    p_target_uid: authUid,
  });
  if (error) {
    if (looksLikeMissingFunction(error.message)) {
      throw new Error(SCHEMA_OUT_OF_DATE_HINT);
    }
    throw new Error(error.message);
  }
  const res = data as { error?: string; ok?: boolean; changed?: boolean };
  if (res?.error || !res?.ok) {
    throw new Error(res?.error ?? 'Could not revoke league admin');
  }
  return { changed: !!res.changed };
}

export async function grantOrgAdminByEmail(
  orgId: string,
  email: string,
  fallbackAdminUserId?: string,
): Promise<{ authUid: string; previousRole: string }> {
  const { data, error } = await supabase.rpc('grant_org_admin_by_email', {
    p_org_id: orgId,
    p_email: email,
    p_admin_user_id: fallbackAdminUserId ?? null,
  });
  if (error) {
    if (looksLikeMissingFunction(error.message)) {
      throw new Error(SCHEMA_OUT_OF_DATE_HINT);
    }
    throw new Error(error.message);
  }
  const res = data as {
    error?: string;
    ok?: boolean;
    auth_uid?: string;
    previous_role?: string;
  };
  if (res?.error || !res?.ok) {
    throw new Error(res?.error ?? 'Could not grant org admin');
  }
  return {
    authUid: res.auth_uid ?? '',
    previousRole: res.previous_role ?? 'none',
  };
}
