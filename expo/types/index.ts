// Contact / weight rule. "play_up" used to live here as well, but it's
// orthogonal (a kid can play up AND be in the open division), so it
// moved to its own boolean `playsUp` on Player. Migration 046 backfilled
// existing rows.
export type RestrictionStatus = 
  | 'none'
  | 'penny_player'
  | 'open_division';

export interface Player {
  id: string;
  firstName: string;
  lastName: string;
  club: string;
  ageGroup: string;
  division: string;
  teamName: string;
  dateOfBirth: string;
  parentName?: string;
  parentPhone?: string;
  isAgeVerified: boolean;
  photoUri: string | null;
  weight: string;
  checkedIn: boolean;
  checkedInAt: string | null;
  restrictionStatus?: RestrictionStatus;
  // Coach-elected age-bracket bump (typically one bracket up). Independent
  // of restrictionStatus -- a player can play up AND be in open division.
  playsUp?: boolean;
  calculatedAgeGroup?: string;
  /** Client-managed monotonic timestamp set on every upsert, used for
   *  per-field last-write-wins merge decisions. Never touched by the
   *  DB trigger (unlike updated_at). */
  clientUpdatedAt?: string;
}

export interface Club {
  id: string;
  name: string;
}

export interface AgeGroup {
  id: string;
  name: string;
  minAge: number;
  maxAge: number;
}

export interface Division {
  id: string;
  name: string;
}

export type CheckInStatusFilter = 'pending' | 'checkedIn';

export interface RegistrationFilters {
  club: string | null;
  ageGroup: string | null;
  division: string | null;
  teamName?: string | null;
  status?: CheckInStatusFilter | null;
}

export type UserOrgRole = 'owner' | 'admin' | 'coach' | 'volunteer' | 'viewer';

export interface Organization {
  id: string;
  name: string;
  code: string;
  logoUri: string | null;
  primaryColor: string;
  createdAt: string;
  ownerId: string;
  expiresAt: string;
  // is_active was added in migration 040. Treat undefined/null as true so
  // pre-040 orgs read from device cache before sync still appear as active.
  isActive: boolean;
}

export interface OrgMember {
  id: string;
  orgId: string;
  userId: string;
  role: UserOrgRole;
  email: string;
  name: string;
  joinedAt: string;
}

export interface Team {
  id: string;
  orgId: string;
  name: string;
  ageGroup: string;
  division: string;
  coachName: string;
  coachPhone: string;
  coachEmail: string;
  createdAt: string;
}

export type EventStatus = 'draft' | 'active' | 'completed' | 'cancelled';

export interface Event {
  id: string;
  orgId: string;
  name: string;
  location: string;
  startDate: string;
  endDate: string;
  status: EventStatus;
  description: string;
  createdAt: string;
  checkInOpen: boolean;
}

export interface EventTeam {
  id: string;
  eventId: string;
  teamId: string;
  teamName: string;
  orgName: string;
  isHomeTeam: boolean;
  checkedInCount: number;
  totalPlayers: number;
}

export type VerificationStatus = 'pending' | 'verified' | 'flagged' | 'rejected';

export interface OpponentVerification {
  id: string;
  eventId: string;
  verifyingTeamId: string;
  opponentTeamId: string;
  playerId: string;
  playerName: string;
  status: VerificationStatus;
  flagReason: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

export interface EventCheckIn {
  id: string;
  eventId: string;
  teamId: string;
  playerId: string;
  checkedInBy: string;
  checkedInAt: string;
  photoUri: string | null;
  weightVerified: boolean;
  ageVerified: boolean;
  syncStatus: 'synced' | 'pending' | 'failed';
}

export interface OfflineCheckIn {
  id: string;
  eventId: string;
  teamId: string;
  playerId: string;
  checkedInBy: string;
  checkedInAt: string;
  photoUri: string | null;
  weightVerified: boolean;
  ageVerified: boolean;
  createdOfflineAt: string;
}

export interface OrgPrivacySettings {
  id: string;
  orgId: string;
  showFullName: boolean;
  showJerseyNumber: boolean;
  showBirthYear: boolean;
  showPhoto: boolean;
  showWeight: boolean;
  verificationPassDurationMinutes: number;
  updatedAt: string;
}

export interface VerificationPass {
  id: string;
  eventId: string;
  issuingTeamId: string;
  issuingOrgId: string;
  code: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
  createdBy: string;
  isRevoked: boolean;
  revokedAt: string | null;
  revokedBy: string | null;
}

export interface VerificationView {
  id: string;
  passId: string;
  eventId: string;
  viewedTeamId: string;
  viewerUserId: string | null;
  viewerIp: string | null;
  viewedAt: string;
  playerCount: number;
}

export interface LimitedPlayerData {
  id: string;
  displayName: string;
  jerseyNumber: string | null;
  birthYear: string | null;
  photoUri: string | null;
  weight: string | null;
  ageGroup: string;
  division: string;
}

export interface ImportedSheet {
  id: string;
  spreadsheetId: string;
  url: string;
  title: string;
  accessCode: string;
  importedAt: string;
  lastUsedAt: string;
  importedBy: string;
  playerCount: number;
  isLocked: boolean;
  allowEditing: boolean;
}

export interface Coach {
  id: string;
  firstName: string;
  lastName: string;
  photoUri: string | null;
  isCertified: boolean;
  checkedIn: boolean;
  checkedInAt: string | null;
}

export interface CoachTeam {
  id: string;
  coachId: string;
  orgId: string;
  club: string;
  ageGroup: string;
  division: string;
  teamName: string;
}
