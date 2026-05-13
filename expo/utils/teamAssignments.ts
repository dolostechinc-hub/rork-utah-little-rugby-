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
