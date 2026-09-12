import type { Card, GameState, Rank } from '../types';
import { createDeck } from '../engine/deck';

// ---------------------------------------------------------------------------
// Card counting — gives the bot a genuine, non-cheating notion of "what could still be out
// there" without reading the opponent's exact hand/reserve split. The engine's GameState happens
// to expose every player's hand directly (there is no client/server visibility separation at the
// type level), but the bot deliberately does not use the opponent's hand contents in its
// reasoning — only the POOLED set of cards it hasn't itself accounted for. This keeps the
// strategy honest (it reasons the way a real player at the table would, using only what's
// actually visible to everyone: the floor, both captured piles, and its own hand) while still
// giving real card-counting signal: which values are still live, and how concentrated they are.
// ---------------------------------------------------------------------------

const RANK_VALUES: Record<Rank, number> = {
  A: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13
};

export function rankValue(rank: Rank): number {
  return RANK_VALUES[rank];
}

const FULL_DECK_IDS = new Set(createDeck().map(c => c.id));

/**
 * Every physical card not accounted for by: `forPlayerId`'s own hand/reserve, the floor (loose
 * and house cards — visible to everyone), and either player's captured pile (also visible to
 * everyone once captured). What remains is exactly "somewhere the bot cannot currently see" —
 * the opponent's hand, the opponent's reserve, and any residual deck. This is the pool used for
 * risk estimation; the bot never looks at how it's actually split between those locations.
 */
export function unseenCards(state: GameState, forPlayerId: string): Card[] {
  const self = state.players.find(p => p.id === forPlayerId);
  if (!self) throw new Error(`Unknown player: ${forPlayerId}`);

  const accountedFor = new Map<string, Card>();
  const account = (cards: Card[]) => cards.forEach(c => accountedFor.set(c.id, c));
  account(self.hand);
  account(self.reserve);
  account(state.floor.loose);
  state.floor.houses.forEach(h => account(h.cards));
  state.players.forEach(p => account(p.captured));

  const unseen: Card[] = [];
  for (const id of FULL_DECK_IDS) {
    if (!accountedFor.has(id)) {
      // Reconstruct the Card from its id (rank-suit) — cheaper than keeping a second lookup table.
      const [rank, suit] = id.split('-') as [Card['rank'], Card['suit']];
      unseen.push({ id, rank, suit });
    }
  }
  return unseen;
}

/**
 * A rough estimate of how likely it is that the opponent can immediately capture something worth
 * exactly `value` — the fraction of unseen cards whose own rank value equals `value`, plus a
 * small bonus if at least two unseen cards could combine to it. This is deliberately simple (not
 * a full combinatorial probability model) — Section 11's own guidance is not to build an
 * elaborate probabilistic model the available information doesn't support; this is a heuristic
 * signal, not a precise probability, and is used as one weighted input to the evaluation
 * function, not as a certainty.
 */
export function estimatedCaptureRisk(unseen: Card[], value: number): number {
  if (unseen.length === 0) return 0;
  const directMatches = unseen.filter(c => rankValue(c.rank) === value).length;
  const hasPairCombo = unseen.some((a, i) => unseen.slice(i + 1).some(b => rankValue(a.rank) + rankValue(b.rank) === value));
  const direct = directMatches / unseen.length;
  return Math.min(1, direct + (hasPairCombo ? 0.15 : 0));
}
