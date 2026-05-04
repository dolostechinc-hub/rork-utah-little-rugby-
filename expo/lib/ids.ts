// Collision-resistant id generator used for local roster entries.
//
// Why this exists:
//   The legacy code used `Date.now().toString()` and
//   `imported-${Date.now()}-${index}` to mint player ids. Two volunteers
//   creating players in the same millisecond, or two devices importing
//   the same spreadsheet, would collide on `id`. Combined with
//   `roster_players.id PRIMARY KEY`, this could move/overwrite a row that
//   belonged to another org.
//
// Strategy:
//   Prefer `crypto.randomUUID()` when available (Hermes 0.74+, web).
//   Fall back to a high-entropy timestamp + Math.random combo for older
//   runtimes. Either is sufficient now that the schema enforces uniqueness
//   on `(org_id, id)` rather than `id` alone.

function fallbackRandomId(prefix?: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  const rand2 = Math.random().toString(36).slice(2, 10);
  const core = `${ts}-${rand}${rand2}`;
  return prefix ? `${prefix}-${core}` : core;
}

export function randomId(prefix?: string): string {
  try {
    const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (cryptoObj?.randomUUID) {
      const uuid = cryptoObj.randomUUID();
      return prefix ? `${prefix}-${uuid}` : uuid;
    }
  } catch {
    // ignore and fall through
  }
  return fallbackRandomId(prefix);
}
