const TEAM_ASSIGNMENT_DELIMITER = ' || ';

export function parseTeamAssignments(teamName: string | null | undefined): string[] {
  const raw = (teamName || '').toString().trim();
  if (!raw) return [];

  return raw
    .split(TEAM_ASSIGNMENT_DELIMITER)
    .map((name) => name.trim())
    .filter(Boolean)
    .filter((name, index, all) => {
      const normalized = name.toLowerCase();
      return all.findIndex((other) => other.toLowerCase() === normalized) === index;
    });
}

export function serializeTeamAssignments(teamNames: string[]): string {
  return teamNames
    .map((name) => name.trim())
    .filter(Boolean)
    .filter((name, index, all) => {
      const normalized = name.toLowerCase();
      return all.findIndex((other) => other.toLowerCase() === normalized) === index;
    })
    .join(TEAM_ASSIGNMENT_DELIMITER);
}

export function formatTeamAssignments(teamName: string | null | undefined): string {
  return parseTeamAssignments(teamName).join(', ');
}

export function playerHasTeam(
  playerTeamName: string | null | undefined,
  selectedTeamName: string | null | undefined,
): boolean {
  const target = (selectedTeamName || '').trim().toLowerCase();
  if (!target) return true;
  return parseTeamAssignments(playerTeamName).some((teamName) => teamName.toLowerCase() === target);
}

/**
 * Sort key for a team name string. Teams matching "U{number} ..." are sorted
 * by the age number numerically, then alphabetically within each age group.
 * Non-matching names sort to the end, alphabetically among themselves.
 */
function teamSortKey(name: string): [number, string] {
  const m = name.match(/^U(\d+)\s+(.*)$/i);
  if (m) {
    const age = parseInt(m[1], 10);
    // Sort by age number then the remaining name text.
    return [age, m[2].toLowerCase()];
  }
  // Non-U-prefixed teams go to the bottom, sorted alphabetically.
  return [Number.POSITIVE_INFINITY, name.toLowerCase()];
}

/**
 * Comparator for team names using the U-age sort key.
 * Pass to Array.sort() for any list of objects with a `name` string property.
 */
export function compareTeamByName(a: { name: string }, b: { name: string }): number {
  const [ageA, restA] = teamSortKey(a.name);
  const [ageB, restB] = teamSortKey(b.name);
  if (ageA !== ageB) return ageA - ageB;
  return restA.localeCompare(restB);
}
