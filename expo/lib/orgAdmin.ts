import { supabase } from '@/lib/supabase';

export interface OrgAdmin {
  member_id: string;
  user_id: string;
  role: 'owner' | 'admin';
  email: string | null;
  name: string | null;
  joined_at: string;
  is_owner: boolean;
}

export async function listOrgAdmins(
  orgId: string,
  adminUserId?: string,
): Promise<OrgAdmin[]> {
  const { data, error } = await supabase.rpc('list_org_admins', {
    p_org_id: orgId,
    p_admin_user_id: adminUserId ?? null,
  });
  if (error) {
    if (/function .* does not exist/i.test(error.message)) {
      throw new Error(
        'Permanent admin management requires a database update. Ask the admin to run migration 030_grant_org_admin.sql.',
      );
    }
    throw new Error(error.message);
  }
  return (data ?? []) as OrgAdmin[];
}

export async function grantOrgAdmin(
  orgId: string,
  targetUserId: string,
  opts?: { adminUserId?: string; email?: string; name?: string },
): Promise<{ memberId: string; previousRole: string }> {
  const { data, error } = await supabase.rpc('grant_org_admin', {
    p_org_id: orgId,
    p_target_user_id: targetUserId,
    p_admin_user_id: opts?.adminUserId ?? null,
    p_email: opts?.email ?? null,
    p_name: opts?.name ?? null,
  });
  if (error) {
    if (/function .* does not exist/i.test(error.message)) {
      throw new Error(
        'Permanent admin management requires a database update. Ask the admin to run migration 030_grant_org_admin.sql.',
      );
    }
    throw new Error(error.message);
  }
  const res = data as {
    error?: string;
    ok?: boolean;
    member_id?: string;
    previous_role?: string;
  };
  if (res?.error || !res?.ok) {
    throw new Error(res?.error ?? 'Could not grant admin');
  }
  return {
    memberId: res.member_id ?? '',
    previousRole: res.previous_role ?? 'none',
  };
}

export async function revokeOrgAdmin(
  orgId: string,
  targetUserId: string,
  adminUserId?: string,
): Promise<{ changed: boolean; previousRole: string | null }> {
  const { data, error } = await supabase.rpc('revoke_org_admin', {
    p_org_id: orgId,
    p_target_user_id: targetUserId,
    p_admin_user_id: adminUserId ?? null,
  });
  if (error) {
    if (/function .* does not exist/i.test(error.message)) {
      throw new Error(
        'Permanent admin management requires a database update. Ask the admin to run migration 030_grant_org_admin.sql.',
      );
    }
    throw new Error(error.message);
  }
  const res = data as {
    error?: string;
    ok?: boolean;
    changed?: boolean;
    previous_role?: string;
  };
  if (res?.error || !res?.ok) {
    throw new Error(res?.error ?? 'Could not revoke admin');
  }
  return {
    changed: !!res.changed,
    previousRole: res.previous_role ?? null,
  };
}
