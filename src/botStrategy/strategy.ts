import type { OpeningAction } from '../types';
import type { OrchestratedGame } from '../engine/roundOrchestrator';
import { discoverLegalMoves, submitBid, submitMove, submitOpeningAction } from '../engine/roundOrchestrator';
import type { NormalPlayMove } from '../engine/moveExecution';
import { flattenOptionsForHand, toNormalPlayMove, toOpeningAction } from '../engine/moveAdapter';
import { evaluate } from './evaluate';

// ---------------------------------------------------------------------------
// Strategy / search. Every simulation below goes through the SAME orchestrator entry points a
// human player's UI action or an automated test driver would use (submitBid/submitOpeningAction/
// submitMove) — this is safe because those functions are pure (they return a new state, never
// mutate their input), so "simulate a hypothetical" and "actually do it" are the same call; the
// only difference is whether the caller keeps or discards the result. The bot never calls a
// lower-level engine function directly and never re-derives legality itself — discoverLegalMoves
// (Ingredient 4, via the orchestrator) is the only source of what's legal.
//
// Search shape: a full 1-ply evaluation of every legal option, refined by a bounded 2-ply
// minimax (best response assumed from the opponent) for only the top candidates — see
// TOP_K_FOR_LOOKAHEAD / MAX_OPPONENT_REPLIES_CONSIDERED below for the exact bound. This keeps the
// browser responsive (bounded branching, no unbounded recursion) while still looking one full
// exchange ahead for the moves that matter most, per the frozen "bounded search with a strong
// evaluation function" guidance.
// ---------------------------------------------------------------------------

export interface ScoredCandidate<T> {
  choice: T;
  score: number;
}

export interface BotDecision<T> {
  choice: T;
  score: number;
  candidates: ScoredCandidate<T>[];
}

const TOP_K_FOR_LOOKAHEAD = 5;
const MAX_OPPONENT_REPLIES_CONSIDERED = 12;

function otherPlayerId(game: OrchestratedGame, playerId: string): string {
  const other = game.state.players.find(p => p.id !== playerId);
  if (!other) throw new Error(`Expected exactly two players; could not find an opponent for ${playerId}.`);
  return other.id;
}

/**
 * Chooses the bid value. There is no "move" to search here — the strategic choice is which
 * caller-eligible value (9–13) to call, and Build Priority means the value chosen determines
 * whether the bidder is then forced to build. Rather than guessing at that interaction, this
 * simulates the FULL consequence of each eligible value — the bid, the resulting mandatory-or-not
 * opening action Ingredient 4 discovers, and that action's outcome — and picks whichever value
 * leaves the bidder in the best evaluated position. This reuses the exact same
 * discover→simulate→evaluate pattern as move selection, just for a smaller, differently-shaped
 * decision.
 */
export function chooseBid(game: OrchestratedGame, playerId: string): BotDecision<number> {
  const hand = game.state.players.find(p => p.id === playerId)?.hand ?? [];
  const RANK_VALUES: Record<string, number> = { A: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13 };
  const eligibleValues = [...new Set(hand.map(c => RANK_VALUES[c.rank]).filter(v => v >= 9 && v <= 13))];
  if (eligibleValues.length === 0) {
    throw new Error(`${playerId} holds no caller-eligible (9–13) card — this violates the frozen deal guarantee and should be unreachable.`);
  }

  const candidates = eligibleValues.map(value => {
    const afterBid = submitBid(game, playerId, value);
    const openingOptions = flattenOptionsForHand(discoverLegalMoves(afterBid, playerId));
    if (openingOptions.length === 0) {
      // Should not happen (the eligible-value bid guarantees at least a throw is legal), but
      // don't let a defensive gap crash move selection — just treat it as a poor outcome.
      return { choice: value, score: -Infinity };
    }
    const bestOpeningResult = openingOptions
      .map(opt => submitOpeningAction(afterBid, playerId, toOpeningAction(opt)))
      .map(after => evaluate(after.state, playerId).total)
      .reduce((best, s) => Math.max(best, s), -Infinity);
    return { choice: value, score: bestOpeningResult };
  });

  candidates.sort((a, b) => b.score - a.score);
  return { choice: candidates[0].choice, score: candidates[0].score, candidates };
}

/**
 * Chooses the opening action. Ingredient 4 already enforces Build Priority (build > capture >
 * throw where applicable), so whatever discoverLegalMoves returns during the opening decision is
 * already the correct, narrowed set — the bot only ever picks among what's actually offered.
 */
export function chooseOpeningAction(game: OrchestratedGame, playerId: string): BotDecision<OpeningAction> {
  const options = flattenOptionsForHand(discoverLegalMoves(game, playerId));
  if (options.length === 0) throw new Error(`No legal opening action available for ${playerId}.`);

  const candidates = options.map(opt => {
    const action = toOpeningAction(opt);
    const after = submitOpeningAction(game, playerId, action);
    return { choice: action, score: evaluate(after.state, playerId).total };
  });
  candidates.sort((a, b) => b.score - a.score);
  return { choice: candidates[0].choice, score: candidates[0].score, candidates };
}

/**
 * Chooses a normal-play move. See the module-level comment for the search shape: full 1-ply
 * evaluation of every legal option, then a bounded 2-ply minimax refinement (assume the opponent
 * plays their own best reply) for the top few candidates only.
 */
export function chooseMove(game: OrchestratedGame, playerId: string): BotDecision<NormalPlayMove> {
  const options = flattenOptionsForHand(discoverLegalMoves(game, playerId));
  if (options.length === 0) throw new Error(`No legal move available for ${playerId} despite it being their turn.`);

  const opponentId = otherPlayerId(game, playerId);

  const depth1 = options.map(opt => {
    const move = toNormalPlayMove(opt);
    const after = submitMove(game, playerId, move);
    return { choice: move, score: evaluate(after.state, playerId).total, after };
  });
  depth1.sort((a, b) => b.score - a.score);

  const refined: ScoredCandidate<NormalPlayMove>[] = depth1.map((candidate, index) => {
    if (index >= TOP_K_FOR_LOOKAHEAD) return { choice: candidate.choice, score: candidate.score };

    const { after } = candidate;
    if (after.state.phase !== 'playing' || after.state.players[after.state.currentPlayerIndex].id !== opponentId) {
      // The round ended, or it's somehow still our turn (e.g. an opponent with no cards was
      // skipped straight back to us) — depth-1's evaluation already reflects the real outcome.
      return { choice: candidate.choice, score: candidate.score };
    }

    const opponentOptions = flattenOptionsForHand(discoverLegalMoves(after, opponentId)).slice(0, MAX_OPPONENT_REPLIES_CONSIDERED);
    if (opponentOptions.length === 0) return { choice: candidate.choice, score: candidate.score };

    let worstForUs = Infinity;
    for (const opt of opponentOptions) {
      const opponentMove = toNormalPlayMove(opt);
      const afterReply = submitMove(after, opponentId, opponentMove);
      const scoreForUs = evaluate(afterReply.state, playerId).total;
      if (scoreForUs < worstForUs) worstForUs = scoreForUs;
    }
    return { choice: candidate.choice, score: worstForUs };
  });

  refined.sort((a, b) => b.score - a.score);
  return { choice: refined[0].choice, score: refined[0].score, candidates: refined };
}
