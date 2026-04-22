import { RestrictionStatus } from '@/types';
import {
  calculateAgeGroup,
  checkWeightRestriction,
  getNextAgeGroup,
  getWeightLimit,
} from '@/utils/playerUtils';

export { calculateAgeGroup, checkWeightRestriction, getNextAgeGroup, getWeightLimit };

export interface EligibilityInput {
  dateOfBirth: string | null | undefined;
  ageGroup: string;
  division: string;
  weightLbs: number | string | null | undefined;
  /** Explicit restriction set by the user (e.g. via weight modal). Wins over auto. */
  userSelectedRestriction?: RestrictionStatus;
}

export interface EligibilityResult {
  calculatedAgeGroup: string | null;
  effectiveAgeGroup: string;
  restrictionStatus: RestrictionStatus;
  isOverweight: boolean;
  weightLimit: number | null;
}

/**
 * Single source of truth for Utah Little Rugby eligibility.
 * Keeps existing `playerUtils` logic and layers a deterministic result.
 */
export function computeEligibility(input: EligibilityInput): EligibilityResult {
  const calculatedAgeGroup = input.dateOfBirth
    ? calculateAgeGroup(input.dateOfBirth)
    : null;
  const effectiveAgeGroup = calculatedAgeGroup || input.ageGroup || '';

  const weightStr =
    typeof input.weightLbs === 'number'
      ? String(input.weightLbs)
      : (input.weightLbs ?? '').toString();

  const check = checkWeightRestriction(
    effectiveAgeGroup,
    weightStr,
    input.division || ''
  );

  let restrictionStatus: RestrictionStatus =
    input.userSelectedRestriction ?? 'none';

  if (!input.userSelectedRestriction && check.isOverweight) {
    // Default automatic status when nothing explicitly chosen yet.
    restrictionStatus = 'penny_player';
  }

  return {
    calculatedAgeGroup,
    effectiveAgeGroup,
    restrictionStatus,
    isOverweight: check.isOverweight,
    weightLimit: check.limit,
  };
}
