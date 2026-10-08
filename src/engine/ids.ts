/**
 * A unique id for a house.
 *
 * `crypto.randomUUID` exists only in a SECURE CONTEXT — https, or localhost. A phone opening the
 * dev server over the local network (http://192.168.x.x) is not one, so the call is simply not
 * there, and every move that created a house threw and took the whole table down with it. That is
 * a blank screen on the one device the game is most likely to be played on.
 *
 * The fallback does not need to be cryptographic. A house id is an opaque handle used to find a
 * house inside one game state; it is never persisted across games, never a secret, and never
 * compared against anything but another id from the same state. Time plus a counter plus some
 * randomness is comfortably enough to keep two houses apart, including two made in the same
 * millisecond.
 */

let sequence = 0;

export function newHouseId(): string {
  const unique =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${(sequence++).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `house-${unique}`;
}
