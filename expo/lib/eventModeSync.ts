import { supabase } from './supabase';

export type EventModeRemote = 'registration' | 'viewOnly';

export async function fetchOrgEventMode(orgId: string): Promise<EventModeRemote | null> {
  if (!orgId) return null;
  try {
    const { data, error } = await supabase.rpc('get_org_event_mode', { p_org_id: orgId });
    if (error) {
      console.warn('[eventModeSync] get_org_event_mode failed:', error.message);
      return null;
    }
    const mode = data as string | null;
    if (mode === 'registration' || mode === 'viewOnly') return mode;
    return null;
  } catch (err) {
    console.warn('[eventModeSync] fetchOrgEventMode threw:', err);
    return null;
  }
}

export async function setOrgEventMode(
  orgId: string,
  mode: EventModeRemote,
  adminUserId: string,
): Promise<void> {
  if (!orgId) throw new Error('Missing org id');
  const { error } = await supabase.rpc('set_org_event_mode', {
    p_org_id: orgId,
    p_mode: mode,
    p_admin_user_id: adminUserId,
  });
  if (error) {
    console.warn('[eventModeSync] set_org_event_mode failed:', error.message);
    throw new Error(error.message);
  }
}

export function subscribeOrgEventMode(
  orgId: string,
  onChange: (mode: EventModeRemote) => void,
): () => void {
  if (!orgId) return () => {};
  console.log('[eventModeSync] subscribing realtime for org', orgId);
  const channel = supabase
    .channel(`org_event_mode:${orgId}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'organizations',
        filter: `id=eq.${orgId}`,
      },
      (payload) => {
        try {
          const row = payload.new as { event_mode?: string } | null;
          const mode = row?.event_mode;
          if (mode === 'registration' || mode === 'viewOnly') {
            console.log('[eventModeSync] realtime event_mode change ->', mode);
            onChange(mode);
          }
        } catch (err) {
          console.warn('[eventModeSync] realtime handler failed:', err);
        }
      },
    )
    .subscribe((status) => {
      console.log('[eventModeSync] channel status:', status);
    });

  return () => {
    console.log('[eventModeSync] unsubscribing channel for org', orgId);
    try {
      supabase.removeChannel(channel);
    } catch (err) {
      console.warn('[eventModeSync] removeChannel failed:', err);
    }
  };
}
