import { RestrictionStatus } from '@/types';

export const AGE_GROUP_CUTOFFS = {
  'U6': new Date('2019-07-01'),
  'U8': new Date('2017-07-01'),
  'U10': new Date('2015-07-01'),
  'U12': new Date('2013-07-01'),
  'U14': new Date('2011-07-01'),
} as const;

export const WEIGHT_LIMITS: Record<string, number> = {
  'U8': 100,
  '8U': 100,
  'U10': 120,
  '10U': 120,
  'U12': 140,
  '12U': 140,
};

export function parseDateOfBirth(dob: string): Date | null {
  if (!dob) return null;
  
  const formats = [
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
    /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
  ];
  
  for (const format of formats) {
    const match = dob.match(format);
    if (match) {
      if (format === formats[0]) {
        const [, month, day, year] = match;
        return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
      } else {
        const [, year, month, day] = match;
        return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
      }
    }
  }
  
  const parsed = new Date(dob);
  return isNaN(parsed.getTime()) ? null : parsed;
}

export function calculateAgeGroup(dateOfBirth: string): string | null {
  const dob = parseDateOfBirth(dateOfBirth);
  if (!dob) return null;
  
  if (dob > AGE_GROUP_CUTOFFS['U6']) {
    return 'U6';
  } else if (dob > AGE_GROUP_CUTOFFS['U8']) {
    return 'U8';
  } else if (dob > AGE_GROUP_CUTOFFS['U10']) {
    return 'U10';
  } else if (dob > AGE_GROUP_CUTOFFS['U12']) {
    return 'U12';
  } else if (dob > AGE_GROUP_CUTOFFS['U14']) {
    return 'U14';
  }
  
  return null;
}

export function getWeightLimit(ageGroup: string): number | null {
  const normalizedAgeGroup = ageGroup.toUpperCase().replace(/\s+/g, '');
  return WEIGHT_LIMITS[normalizedAgeGroup] || null;
}

export function checkWeightRestriction(
  ageGroup: string,
  weight: string,
  division: string
): { isOverweight: boolean; limit: number | null; currentWeight: number } {
  const normalizedDivision = division.toLowerCase();
  const isRestrictedDivision = normalizedDivision.includes('restricted') || 
                                normalizedDivision === 'restricted';
  
  const weightNum = parseFloat(weight);
  const limit = getWeightLimit(ageGroup);
  
  if (!isRestrictedDivision || !limit || isNaN(weightNum)) {
    return { isOverweight: false, limit, currentWeight: weightNum };
  }
  
  return {
    isOverweight: weightNum > limit,
    limit,
    currentWeight: weightNum,
  };
}

export function getNextAgeGroup(currentAgeGroup: string): string | null {
  const ageGroupOrder = ['U6', 'U8', 'U10', 'U12', 'U14'];
  const normalizedCurrent = currentAgeGroup.toUpperCase().replace(/\s+/g, '');
  
  const currentIndex = ageGroupOrder.findIndex(
    ag => ag === normalizedCurrent || ag.replace('U', '') === normalizedCurrent.replace('U', '')
  );
  
  if (currentIndex === -1 || currentIndex === ageGroupOrder.length - 1) {
    return null;
  }
  
  return ageGroupOrder[currentIndex + 1];
}

export function getRestrictionStatusLabel(status: RestrictionStatus): string {
  switch (status) {
    case 'penny_player':
      return 'Pennie Player (Touch Only)';
    case 'play_up':
      return 'Playing Up';
    case 'open_division':
      return 'Open Division';
    default:
      return '';
  }
}

export function getRestrictionStatusColor(status: RestrictionStatus): string {
  switch (status) {
    case 'penny_player':
      return '#F59E0B';
    case 'play_up':
      return '#8B5CF6';
    case 'open_division':
      return '#3B82F6';
    default:
      return '#6B7280';
  }
}
