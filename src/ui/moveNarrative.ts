import { cardPoints, sweepPoints } from '../engine/scoring';
import type { Card, GameState, House } from '../types';

/**
 * What just happened, in a sentence.
 *
 * The engine keeps no move log — `state.history` records captures only, and only so the leftover
 * cards at round end can find their last capturer — so a player watching a shared table sees the
 * score move and the floor change with no account of what their opponent did. A whole round of
 * real play was spent inferring moves from arithmetic; this is the fix for that.
 *
 * It is a DIFF, not a record: two consecutive states in, one receipt out. That means it describes
 * everyone's moves identically, including moves made by a computer seat or by the clock on
 * somebody's behalf, and needs nothing added to the engine or written down anywhere.
 */

const SUIT: Record<Card['suit'], string> = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };

/** "10♠" — how a card is named in a receipt. */
export function cardName(card: Card): string {
  return `${card.rank}${SUIT[card.suit]}`;
}

export type MoveKind = 'capture' | 'build' | 'cement' | 'addToHouse' | 'raise' | 'throw' | 'reserve' | 'unknown';

export interface MoveReceipt {
  /** Who played, as a player id — the caller names them. */
  actorId: string | null;
  kind: MoveKind;
  /** "10♠ captured 6♣ + 4♠", "Built 11-house · 7♦ + 4♣ = 11". Never empty. */
  text: string;
  /** Card points taken by this move. Omitted when the move took nothing. */
  points?: number;
  /** A sweep's value, straight from the engine's own schedule. */
  seepPoints?: number;
}

const handsOf = (state: GameState) => new Map(state.players.map(p => [p.id, p.hand]));
const byId = (cards: Card[]) => new Map(cards.map(c => [c.id, c]));

function housesById(state: GameState): Map<string, House> {
  return new Map(state.floor.houses.map(h => [h.id, h]));
}

function listCards(cards: Card[]): string {
  return cards.map(cardName).join(' + ');
}

/**
 * The one card that left a hand between these two states, and whose hand it left.
 *
 * Every move plays exactly one card, so this identifies the actor without being told whose turn it
 * was — which matters because a turn can be taken by the clock rather than by the player.
 */
function cardPlayed(prev: GameState, next: GameState): { actorId: string; card: Card } | null {
  const after = handsOf(next);
  for (const [id, hand] of handsOf(prev)) {
    const stillThere = byId(after.get(id) ?? []);
    const gone = hand.filter(c => !stillThere.has(c.id));
    // A reserve activating replaces a whole hand at once; that is not a play.
    if (gone.length === 1) return { actorId: id, card: gone[0] };
  }
  return null;
}

/** Cards that arrived in somebody's captured pile. */
function newlyCaptured(prev: GameState, next: GameState, actorId: string): Card[] {
  const before = byId(prev.players.find(p => p.id === actorId)?.captured ?? []);
  return (next.players.find(p => p.id === actorId)?.captured ?? []).filter(c => !before.has(c.id));
}

/**
 * Reads one move out of the change between two states.
 *
 * Returns null when nothing a player did explains the difference — a fresh deal, a scored round —
 * so the caller can simply keep showing the previous receipt rather than inventing one.
 */
export function describeMove(prev: GameState, next: GameState): MoveReceipt | null {
  // The two-handed reserve coming into play: every hand refills at once, from nobody's turn.
  const reserveJustActivated =
    prev.players.some(p => p.reserve.length > 0) && next.players.every(p => p.reserve.length === 0);
  if (reserveJustActivated && next.players.some(p => p.hand.length > 0)) {
    return { actorId: null, kind: 'reserve', text: 'Second half begins — reserve cards are now in play.' };
  }

  const play = cardPlayed(prev, next);
  if (!play) return null;
  const { actorId, card } = play;
  const played = cardName(card);

  const sweeps = next.sweepRecords.length - prev.sweepRecords.length;
  const seepPoints = sweeps > 0 ? sweepValue(next) : undefined;

  const took = newlyCaptured(prev, next, actorId);
  if (took.length > 0) {
    const others = took.filter(c => c.id !== card.id);
    const points = took.reduce((sum, c) => sum + cardPoints(c), 0);
    return {
      actorId,
      kind: 'capture',
      text: others.length ? `${played} collected ${listCards(others)}` : `${played} collected the floor`,
      points,
      seepPoints
    };
  }

  const before = housesById(prev);
  const after = housesById(next);
  const added = [...after.values()].filter(h => !before.has(h.id));
  const grown = [...after.values()].filter(h => {
    const was = before.get(h.id);
    return was && h.cards.length > was.cards.length;
  });

  if (added.length === 1 && before.size === after.size - 1) {
    const house = added[0];
    const withCards = house.cards.filter(c => c.id !== card.id);
    return {
      actorId,
      kind: 'build',
      text: `Built a ${house.captureValue}-house · ${played}${withCards.length ? ` + ${listCards(withCards)}` : ''}`
    };
  }
  if (added.length === 1) {
    // One house replaced another: the value was raised, or two houses were merged into one.
    const house = added[0];
    return { actorId, kind: 'raise', text: `Raised a house to ${house.captureValue} · ${played}` };
  }
  if (grown.length === 1) {
    const house = grown[0];
    const was = before.get(house.id)!;
    const joined = house.cards.filter(c => !byId(was.cards).has(c.id) && c.id !== card.id);
    const verb = was.isCemented ? 'Added to' : 'Cemented';
    return {
      actorId,
      kind: was.isCemented ? 'addToHouse' : 'cement',
      text: `${verb} the ${house.captureValue}-house · ${played}${joined.length ? ` + ${listCards(joined)}` : ''}`
    };
  }

  const landed = next.floor.loose.some(c => c.id === card.id);
  if (landed) return { actorId, kind: 'throw', text: `${played} played to the floor` };

  return { actorId, kind: 'unknown', text: `${played} played` };
}

/**
 * What the sweep just recorded was worth.
 *
 * Asks the engine's own sweepPoints rather than restating the schedule here: this file had its own
 * copy of it for about an hour, and a change to the opening-sweep value would have left the table
 * announcing one number while the score card paid another.
 */
function sweepValue(next: GameState): number {
  const record = next.sweepRecords[next.sweepRecords.length - 1];
  return record ? sweepPoints(record) : 0;
}

// ---------------------------------------------------------------------------
// What the floor is about to be worth to whoever plays next.
// ---------------------------------------------------------------------------

/** Loose cards plus houses — the things a capture has to clear to sweep the floor. */
export function floorItems(state: GameState): number {
  return state.floor.loose.length + state.floor.houses.length;
}

/** Card points lying loose on the floor, which is the number a player actually wants to know. */
export function loosePoints(state: GameState): number {
  return state.floor.loose.reduce((sum, c) => sum + cardPoints(c), 0);
}

/**
 * What a house is worth to whoever takes it.
 *
 * The question a player asks of a house is never "which cards are in it" — it is "is it worth
 * taking". Two houses of 11 can hold nineteen points or none at all, and the cards themselves say
 * so only to someone adding up spades in their head. The cards remain one press away.
 */
export function housePoints(house: House): number {
  return house.cards.reduce((sum, c) => sum + cardPoints(c), 0);
}

/**
 * True when the floor is one capture away from empty, which is what hands the next player a sweep.
 *
 * Deliberately counts a single HOUSE as sweepable too: a house is taken whole by any matching card,
 * so a floor holding nothing but one house is exactly as dangerous as one holding a single loose
 * card. Two things of different kinds cannot be cleared by one card, so anything above one is safe.
 */
export function floorIsOneCaptureFromEmpty(state: GameState): boolean {
  return floorItems(state) === 1;
}
