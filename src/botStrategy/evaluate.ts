import type { GameState } from '../types';
import { cardPoints, computeRoundScoreBreakdown } from '../engine/scoring';
import { estimatedCaptureRisk, rankValue, unseenCards } from './cardCounting';
import { FULL_STRENGTH_EVALUATION } from './difficulty';
import type { EvaluationPolicy } from './difficulty';

// ---------------------------------------------------------------------------
// Centralized evaluation — every strategic judgment the bot makes runs through this one function,
// per the frozen requirement not to scatter scoring logic across the bot. Point VALUES themselves
// (what a spade is worth, what 10-diamonds is worth, sweep values) are never redefined here —
// `computeRoundScoreBreakdown`/`cardPoints` from the existing scoring engine (Ingredient 7) are
// the only source of point definitions. Everything below is strategic WEIGHTING on top of those
// already-frozen values, not a second scoring system.
// ---------------------------------------------------------------------------

export interface EvaluationBreakdown {
  /** Already-secured points this round: captured cards + recorded sweeps, this side minus the
   * opponent's. Uses Ingredient 7's own computation directly — the single realest signal, so it's
   * weighted most heavily. */
  scoreDifferential: number;
  /** A light nudge from cumulative game score — a side already well ahead can afford to play more
   * conservatively; a side behind should lean into contested opportunities. Deliberately small:
   * this round's own tactics should not be overridden by the running game total. */
  cumulativeDifferential: number;
  /** Loose floor cards, weighted by who is estimated to reach them first: a card the evaluated
   * side can capture on their own very next turn counts close to full value; a card the opponent
   * is likely to reach counts as a loss, discounted by card-counted risk rather than assumed
   * certain. */
  floorLooseValue: number;
  /** Same idea for houses (which are worth their full contained value, not just their capture
   * key's rank) — a house is a bigger prize and a bigger risk than a single loose card. */
  houseValue: number;
  /** Latent value still sitting in the evaluated side's own hand — discounted, since it isn't
   * secured until actually captured, but real: a hand full of spades and aces is a genuine asset. */
  handPotential: number;
  total: number;
}

/**
 * Scores `state` from `forPlayerId`'s perspective. Higher is better for that player. This never
 * reads the opponent's hand/reserve contents directly — only the pooled "unseen" set (see
 * cardCounting.ts) — so the bot reasons the way an attentive human player at the table would,
 * using only what's actually visible: the floor, both captured piles, and its own hand.
 *
 * `policy` decides how much of that reasoning is switched on — see difficulty.ts. Its default is
 * the full-strength evaluation this function has always performed, so an unqualified call is the
 * same call it always was.
 */
export function evaluate(
  state: GameState,
  forPlayerId: string,
  policy: EvaluationPolicy = FULL_STRENGTH_EVALUATION
): EvaluationBreakdown {
  const self = state.players.find(p => p.id === forPlayerId);
  const opponent = state.players.find(p => p.id !== forPlayerId);
  if (!self || !opponent) throw new Error(`evaluate expects exactly two players; could not resolve both sides for ${forPlayerId}.`);

  const roundBreakdown = computeRoundScoreBreakdown(state);
  const scoreDifferential = (roundBreakdown[forPlayerId]?.total ?? 0) - (roundBreakdown[opponent.id]?.total ?? 0);
  const cumulativeDifferential = (state.scores[forPlayerId] ?? 0) - (state.scores[opponent.id] ?? 0);

  const nextPlayerId = state.phase === 'playing' ? state.players[state.currentPlayerIndex]?.id : null;
  const unseen = policy.countsCards ? unseenCards(state, forPlayerId) : [];
  // Not counting cards means having no idea which values are still live — so every value the
  // opponent might answer looks equally, vaguely dangerous.
  const riskAt = (value: number) => (policy.countsCards ? estimatedCaptureRisk(unseen, value) : policy.blindRisk);

  let floorLooseValue = 0;
  for (const card of state.floor.loose) {
    const points = cardPoints(card);
    if (points === 0) continue;
    if (nextPlayerId === forPlayerId) {
      const ownHandCanTakeIt = self.hand.some(c => rankValue(c.rank) === rankValue(card.rank));
      floorLooseValue += points * (ownHandCanTakeIt ? 1 : 0.3);
    } else if (nextPlayerId === opponent.id) {
      floorLooseValue -= points * riskAt(rankValue(card.rank));
    }
  }

  let houseValue = 0;
  for (const house of state.floor.houses) {
    const points = house.cards.reduce((sum, c) => sum + cardPoints(c), 0);
    if (points === 0) continue;
    if (nextPlayerId === forPlayerId) {
      const ownHandCanTakeIt = self.hand.some(c => rankValue(c.rank) === house.captureValue);
      houseValue += points * (ownHandCanTakeIt ? 1 : 0.2);
    } else if (nextPlayerId === opponent.id) {
      houseValue -= points * riskAt(house.captureValue);
    }
  }

  const handPotential = self.hand.reduce((sum, c) => sum + cardPoints(c), 0) * policy.handPotentialWeight;

  const total =
    scoreDifferential * 3 + cumulativeDifferential * policy.cumulativeWeight + floorLooseValue + houseValue + handPotential;
  return { scoreDifferential, cumulativeDifferential, floorLooseValue, houseValue, handPotential, total };
}
