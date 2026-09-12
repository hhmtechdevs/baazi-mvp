/**
 * Who this browser is.
 *
 * Deliberately the smallest thing that works: a random id kept in localStorage, with no account, no
 * password and no sign-in. It survives a refresh and a closed browser, which is the entire
 * requirement — it is how a player who reloads gets their own seat back instead of a new one.
 *
 * It is an identity, not a credential, and the table never takes a browser's word for which seat it
 * holds: the seat is assigned when joining and recorded against this id (see protocol.claimSeat),
 * and every later action is checked against what was recorded.
 */

const SESSION_KEY = 'baazi-session-id';
const LAST_TABLE_KEY = 'baazi-last-code';

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `s-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/** Storage can be unavailable (private mode, blocked site data). A session that only lasts as long
 * as the tab is worse than one that persists, but far better than the app failing to load. */
function safeStorage(): Storage | null {
  try {
    const probe = '__baazi__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

let memorySessionId: string | null = null;

export function sessionId(): string {
  const store = safeStorage();
  if (!store) return (memorySessionId ??= randomId());
  const existing = store.getItem(SESSION_KEY);
  if (existing) return existing;
  const fresh = randomId();
  store.setItem(SESSION_KEY, fresh);
  return fresh;
}

/** The table this browser was last at, so a reload can offer to walk straight back in. */
export function rememberTable(code: string): void {
  safeStorage()?.setItem(LAST_TABLE_KEY, code);
}

export function forgetTable(): void {
  safeStorage()?.removeItem(LAST_TABLE_KEY);
}

export function lastTable(): string | null {
  return safeStorage()?.getItem(LAST_TABLE_KEY) ?? null;
}

/** A code shared as a link: /?table=K7Q4 — the code itself still works typed in by hand, which is
 * the fallback that has to keep working when a link doesn't survive being pasted into a chat. */
export function codeFromUrl(): string | null {
  if (typeof location === 'undefined') return null;
  return new URLSearchParams(location.search).get('table');
}

export function inviteUrl(code: string): string {
  if (typeof location === 'undefined') return code;
  return `${location.origin}${location.pathname}?table=${code}`;
}
