import type { Card, GameState, Rank, SweepRecord } from '../types';

// ---------------------------------------------------------------------------
// Ingredient 7 — scoring + round/game completion. Consumes a state Ingredient 6 has already
// brought to phase 'roundEnd' (leftover loose floor cards already moved to the last capturer's
// `captured` pile — see turnProgression.ts's transitionToRoundEnd) and computes: card points,
// sweep points, per-side round/cumulative scores, and whether the configured game has ended.
// Does not deal cards, does not start a new round, does not decide a winner-take-all outcome.
// ---------------------------------------------------------------------------

const RANK_VALUES: Record<Rank, number> = {
  A: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13
};

function requirePhase(state: GameState, phase: GameState['phase']): void {
  if (state.phase !== phase) {
    throw new Error(`Expected phase "${phase}" but game is in phase "${state.phase}".`);
  }
}

// ---------------------------------------------------------------------------
// Side resolution — deliberately re-derived from `state.teams`, NOT from `player.teamId` or
// `SweepRecord.teamId`. Neither of those fields is ever populated by the actual dealing flow
// (deal.ts's assignDefaultTeamsIfMissing only writes `state.teams`), so trusting them here would
// silently score every 4-player game as if nobody had a team. `state.teams` is the only field the
// real flow actually populates, so it is the only one scoring can rely on. See the Ingredient 7
// report for this finding.
// ---------------------------------------------------------------------------

function sideOf(state: GameState, playerId: string): string {
  if (state.mode === '2player') return playerId;
  const team = state.teams.find(t => t.playerIds.includes(playerId));
  if (!team) {
    throw new Error(
      `Invalid GameState: mode is '4player' but no team entry contains player ${playerId}. Scoring cannot ` +
      'attribute this player\'s cards/sweeps to a side without state.teams being populated.'
    );
  }
  return team.id;
}

/** Every distinct side in this game — the two players in 2-player mode, the two teams in 4-player. */
function allSides(state: GameState): string[] {
  const sides = new Set(state.players.map(p => sideOf(state, p.id)));
  return [...sides];
}

// ---------------------------------------------------------------------------
// Card point values — the frozen 100-point system.
// ---------------------------------------------------------------------------

/**
 * A♠ is handled by the spades branch (worth 1, its rank value) and is never also matched by the
 * "other aces" branch below it — the four aces contribute 4 points total, not 5, per the frozen
 * rule ("A♠ is already included in the 91 spade total").
 */
export function cardPoints(card: Card): number {
  if (card.suit === 'spades') return RANK_VALUES[card.rank]; // 1..13, sums to 91
  if (card.rank === 'A') return 1; // hearts/diamonds/clubs aces
  if (card.rank === '10' && card.suit === 'diamonds') return 6;
  return 0;
}

/** The sweep-value schedule: opening-play sweeps get 25, the literal final play of the round gets
 * 0, every other sweep gets the normal 50 — including a sweep on the second-to-last play, which
 * is explicitly still a normal 50-point sweep per the frozen rule (isFinalPlay only true for the
 * literal last card, never inferred from "close to the end"). isFinalPlay takes precedence over
 * isOpeningPlay in the (practically unreachable, given real deal sizes) case both were somehow
 * true at once. */
export function sweepPoints(record: SweepRecord): number {
  if (record.isFinalPlay) return 0;
  if (record.isOpeningPlay) return 25;
  return 50;
}

export interface SideScoreBreakdown {
  cardPoints: number;
  sweepPoints: number;
  total: number;
}

/**
 * This round's score breakdown per side, derived entirely from existing state — `player.captured`
 * (which, by the time phase is 'roundEnd', already includes any leftover loose floor cards
 * Ingredient 6 awarded to the last capturer) and `state.sweepRecords`. No new GameState field was
 * needed for this; both inputs already exist and are already correctly populated by Ingredients
 * 5/6.
 */
export function computeRoundScoreBreakdown(state: GameState): Record<string, SideScoreBreakdown> {
  const breakdown: Record<string, SideScoreBreakdown> = {};
  for (const side of allSides(state)) {
    breakdown[side] = { cardPoints: 0, sweepPoints: 0, total: 0 };
  }

  for (const player of state.players) {
    const side = sideOf(state, player.id);
    const points = player.captured.reduce((sum, card) => sum + cardPoints(card), 0);
    breakdown[side].cardPoints += points;
  }

  for (const record of state.sweepRecords) {
    const side = sideOf(state, record.playerId);
    breakdown[side].sweepPoints += sweepPoints(record);
  }

  for (const side of Object.keys(breakdown)) {
    breakdown[side].total = breakdown[side].cardPoints + breakdown[side].sweepPoints;
  }
  return breakdown;
}

// ---------------------------------------------------------------------------
// Game length / completion.
//
// Deliberately NOT a GameState field: `dealerId` is already established precedent in this
// codebase as caller-supplied configuration, never persisted on GameState (deal.ts's
// dealOpeningHands takes it as a parameter). Game-length configuration follows the same pattern
// here rather than adding a schema change to the frozen GameState type.
// ---------------------------------------------------------------------------

export type GameLengthConfig =
  | { type: 'fixedRounds'; rounds: number }
  | { type: 'leadTarget'; points: number };

/**
 * Whether the configured game has ended, given the CUMULATIVE scores as they stand after this
 * round's points have already been folded in — the 100-point-lead condition is evaluated only
 * once a round is fully complete (frozen rule), never mid-round; this function is only ever
 * called from completeRound, after roundScores have already been added to scores.
 */
function isGameOver(state: GameState, cumulativeScores: Record<string, number>, config: GameLengthConfig): boolean {
  if (config.type === 'fixedRounds') return state.roundNumber >= config.rounds;
  const values = Object.values(cumulativeScores);
  return Math.max(...values) - Math.min(...values) >= config.points;
}

/**
 * Which SIDE should deal the next round, per the frozen "the side in the lead does not deal —
 * they call/bid instead" rule: the trailing side deals, so the leading side ends up as bidder.
 *
 * Deliberately does not resolve to a specific dealerId. In 2-player mode side === player, so the
 * caller has everything needed. In 4-player mode this identifies which TEAM deals, but not which
 * of that team's two players should be the literal `dealerId` passed to dealOpeningHands — the
 * frozen rules specify which SIDE gets the calling advantage, not which specific seat on a
 * multi-member side becomes dealer. That is a genuine gap, not guessed at here — see the
 * Ingredient 7 report. A tie is reported as `{ tied: true }` for the same reason: the frozen
 * rules don't specify a tie-breaking dealer rule, and none is invented here.
 */
export function determineNextDealerSide(cumulativeScores: Record<string, number>): { side: string } | { tied: true } {
  const entries = Object.entries(cumulativeScores);
  const maxScore = Math.max(...entries.map(([, v]) => v));
  const leaders = entries.filter(([, v]) => v === maxScore);
  if (leaders.length !== 1) return { tied: true };
  const trailing = entries.filter(([side]) => side !== leaders[0][0]);
  // With exactly one leader among exactly two sides, there is exactly one trailing side.
  return { side: trailing[0][0] };
}

export interface RoundCompletionResult {
  state: GameState;
  breakdown: Record<string, SideScoreBreakdown>;
  gameOver: boolean;
  nextDealerSide: { side: string } | { tied: true };
}

/**
 * Completes a round that Ingredient 6 has already brought to phase 'roundEnd': computes this
 * round's score breakdown per side, adds it to the cumulative scores, and decides whether the
 * configured game has ended (transitioning phase to 'gameEnd' if so; otherwise phase stays
 * 'roundEnd', signaling the round is scored and play is paused pending an external decision to
 * deal the next round — starting that next round is out of Ingredient 7's scope).
 */
export function completeRound(state: GameState, config: GameLengthConfig): RoundCompletionResult {
  requirePhase(state, 'roundEnd');

  const breakdown = computeRoundScoreBreakdown(state);
  const roundScores: Record<string, number> = {};
  const scores: Record<string, number> = { ...state.scores };
  for (const side of Object.keys(breakdown)) {
    roundScores[side] = breakdown[side].total;
    scores[side] = (scores[side] ?? 0) + breakdown[side].total;
  }

  const gameOver = isGameOver(state, scores, config);
  const nextDealerSide = determineNextDealerSide(scores);

  return {
    state: { ...state, scores, roundScores, phase: gameOver ? 'gameEnd' : 'roundEnd' },
    breakdown,
    gameOver,
    nextDealerSide
  };
}
