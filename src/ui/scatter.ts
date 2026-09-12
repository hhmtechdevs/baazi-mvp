/**
 * Where loose floor cards sit on the blanket.
 *
 * Loose cards are not a hand and not a pile — they're individual cards somebody dropped on the
 * cloth. They should read as three separate objects standing around the table, each one
 * independently legible, rather than as a tidy row or a little fan tucked under a house. So each
 * card gets its own small displacement and tilt, and the group spreads WIDER when there are fewer
 * of them, instead of collapsing into a cluster.
 *
 * The displacement is derived from the card's own id, not from Math.random: it has to survive every
 * re-render (the table re-renders on each move) without the cards twitching. Same card, same place,
 * for as long as it lies there.
 *
 * Purely presentational — nothing here reads or produces game state.
 */

/** FNV-1a over the card id plus a salt, so one id yields several independent-looking values. */
function hash(seed: string, salt: number): number {
  let h = 0x811c9dc5 ^ salt;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x100000000;
}

/** A stable value in [-1, 1) for this card and axis. */
function signedUnit(cardId: string, salt: number): number {
  return hash(cardId, salt) * 2 - 1;
}

export interface Scatter {
  dx: number;
  dy: number;
  rotate: number;
}

/** How far a card may wander from its slot, and how far it may lean. Restrained on purpose — this
 * is cards lying where they fell, not confetti. */
const MAX_DX = 7;
const MAX_DY = 11;
const MAX_ROTATE = 8;

export function scatterFor(cardId: string): Scatter {
  return {
    dx: Number((signedUnit(cardId, 1) * MAX_DX).toFixed(2)),
    dy: Number((signedUnit(cardId, 2) * MAX_DY).toFixed(2)),
    rotate: Number((signedUnit(cardId, 3) * MAX_ROTATE).toFixed(2))
  };
}

/**
 * Space between loose cards. Few cards claim a broad stretch of floor; many tighten up so the group
 * still fits the table. Never negative — loose cards must not overlap each other, or one of them
 * stops being independently readable, which is the entire point.
 */
export function looseGap(count: number): number {
  if (count <= 1) return 0;
  if (count <= 3) return 56;
  if (count <= 5) return 34;
  if (count <= 8) return 21;
  return 12;
}
