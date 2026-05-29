import createContextHook from '@nkzw/create-context-hook';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

const STORAGE_KEY = 'age_group_rules_links_v2';

export type AgeGroupRulesMap = Record<string, string>;

export const AGE_GROUPS_FOR_RULES: string[] = ['U6', 'U8', 'U10', 'U12', 'U14'];

export const DEFAULT_AGE_GROUP_RULES: AgeGroupRulesMap = {
  U6: 'https://drive.google.com/file/d/1ocfZcsPQaLv984A77TBJjVJAGCBBmTvv/view?usp=drive_link',
  U8: 'https://drive.google.com/file/d/1UIE2JeUphHKWM-TwQwsjeFhS_luo7k-M/view?usp=drive_link',
  U10: 'https://drive.google.com/file/d/10LIH9_31D3t611T_p0DEisb84Ri7aGde/view?usp=drive_link',
  U12: 'https://drive.google.com/file/d/1xZFT0zD86oOjMGbO0P4hjPohJf1MbTOX/view?usp=drive_link',
  U14: 'https://drive.google.com/file/d/14iBkXDLU6jUFEvRixVyTuqzDP_LPJM7F/view?usp=drive_link',
};

async function loadLinks(): Promise<AgeGroupRulesMap> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_AGE_GROUP_RULES };
    const parsed = JSON.parse(raw) as AgeGroupRulesMap;
    if (parsed && typeof parsed === 'object') {
      return { ...DEFAULT_AGE_GROUP_RULES, ...parsed };
    }
    return { ...DEFAULT_AGE_GROUP_RULES };
  } catch (err) {
    console.error('[AgeGroupRules] load error', err);
    return { ...DEFAULT_AGE_GROUP_RULES };
  }
}

async function saveLinks(links: AgeGroupRulesMap): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(links));
}

export const [AgeGroupRulesProvider, useAgeGroupRules] = createContextHook(() => {
  const queryClient = useQueryClient();

  const linksQuery = useQuery<AgeGroupRulesMap>({
    queryKey: ['age-group-rules-links'],
    queryFn: loadLinks,
    staleTime: Infinity,
  });

  const setLinkMutation = useMutation({
    mutationFn: async (params: { ageGroup: string; url: string }) => {
      const current = (await loadLinks()) ?? {};
      const next: AgeGroupRulesMap = { ...current, [params.ageGroup]: params.url };
      await saveLinks(next);
      return next;
    },
    onSuccess: (next) => {
      queryClient.setQueryData(['age-group-rules-links'], next);
    },
  });

  const removeLinkMutation = useMutation({
    mutationFn: async (ageGroup: string) => {
      const current = (await loadLinks()) ?? {};
      const next = { ...current };
      delete next[ageGroup];
      await saveLinks(next);
      return next;
    },
    onSuccess: (next) => {
      queryClient.setQueryData(['age-group-rules-links'], next);
    },
  });

  const setLink = useCallback(
    async (ageGroup: string, url: string) => {
      await setLinkMutation.mutateAsync({ ageGroup, url });
    },
    [setLinkMutation]
  );

  const removeLink = useCallback(
    async (ageGroup: string) => {
      await removeLinkMutation.mutateAsync(ageGroup);
    },
    [removeLinkMutation]
  );

  return {
    links: linksQuery.data ?? {},
    isLoading: linksQuery.isLoading,
    setLink,
    removeLink,
    isSaving: setLinkMutation.isPending || removeLinkMutation.isPending,
  };
});
