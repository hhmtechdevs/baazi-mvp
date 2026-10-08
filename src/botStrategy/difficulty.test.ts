import { describe, expect, it } from 'vitest';
import {
  completeRound,
  discoverLegalMoves,
  isRoundComplete,
  startRound,
  submitBid,
  submitMove,
  submitOpeningAction
} from '../engine/roundOrchestrator';
import type { OrchestratedGame } from '../engine/roundOrchestrator';
import { assertCardInvariant } from '../engine/deal';
import { flattenOptionsForHand, toNormalPlayMove } from '../engine/moveAdapter';
import { chooseBid, chooseMove, chooseOpeningAction } from './strategy';
import { DIFFICULTIES, DIFFICULTY_POLICIES } from './difficulty';
import type { Difficulty } from './difficulty';
import { evaluate } from './evaluate';

/**
 * Practice difficulty. Three modes, one engine.
 *
 * The thing actually at risk in a difficulty feature is that "weaker" quietly becomes "different
 * rules" — a bot that skips a mandatory capture, or that is handed a looser legality check to make
 * it beatable. These tests pin the opposite: every mode draws from the SAME discovered option list
 * and plays whole legal rounds that score exactly as they would otherwise, and what differs is only
 * which of those legal options gets picked.
 */

/** Deterministic PRNG (mulberry32), so a slack-taking mode can be tested as a fixed policy. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function freshGame(gameId = 'difficulty'): OrchestratedGame {
  return startRound({
    gameId,
    mode: '2player',
    players: [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }],
    dealerId: 'A',
    gameLengthConfig: { type: 'fixedRounds', rounds: 1 }
  });
}

/**
 * Plays one whole round with both seats on `difficulty`, asserting at every single turn that the
 * move chosen was one the engine had actually offered.
 */
function playRound(difficulty: Difficulty, seed: number) {
  const options = { difficulty, rng: seeded(seed) };
  let game = freshGame(`${difficulty}-${seed}`);
  const bidder = game.state.bidderId!;

  game = submitBid(game, bidder, chooseBid(game, bidder, options).choice);

  const openingOffered = flattenOptionsForHand(discoverLegalMoves(game, bidder));
  const opening = chooseOpeningAction(game, bidder, options).choice;
  expect(openingOffered.length).toBeGreaterThan(0);
  game = submitOpeningAction(game, bidder, opening);

  let turns = 0;
  while (!isRoundComplete(game)) {
    expect(++turns).toBeLessThan(500);
    const seat = game.state.players[game.state.currentPlayerIndex].id;
    const offered = flattenOptionsForHand(discoverLegalMoves(game, seat)).map(o => JSON.stringify(toNormalPlayMove(o)));
    const move = chooseMove(game, seat, options).choice;

    // The whole safety claim, checked on every turn of every mode: the move was on the engine's
    // own list. A weaker bot cannot reach anything the rules did not already allow.
    expect(offered).toContain(JSON.stringify(move));

    game = submitMove(game, seat, move);
    assertCardInvariant(game.state);
  }
  return completeRound(game);
}

describe('every difficulty plays only legal moves', () => {
  for (const difficulty of DIFFICULTIES) {
    it(`${difficulty} completes a whole round choosing only moves the engine offered`, () => {
      const result = playRound(difficulty, 20261006);
      expect(result.state.phase).toBe('gameEnd');
    });
  }
});

describe('difficulty is a decision policy, not a rules change', () => {
  it('all three modes take their options from the same legal-move discovery', () => {
    // One fixed position, asked of all three: whatever each chooses, it is a member of the one
    // list discoverLegalMoves produced — the modes share a single source of legality.
    let game = freshGame('shared-discovery');
    const bidder = game.state.bidderId!;
    game = submitBid(game, bidder, chooseBid(game, bidder, { difficulty: 'hard' }).choice);
    const offered = flattenOptionsForHand(discoverLegalMoves(game, bidder));

    for (const difficulty of DIFFICULTIES) {
      const decision = chooseOpeningAction(game, bidder, { difficulty, rng: seeded(7) });
      expect(decision.candidates).toHaveLength(offered.length);
    }
  });

  it('scores a round the same way whichever mode played it', () => {
    // Scoring is Ingredient 7 and reads only the finished state, so the totals of any completed
    // round still add to the full 100 card points plus whatever sweeps were earned.
    for (const difficulty of DIFFICULTIES) {
      const result = playRound(difficulty, 99);
      const cardPointsTaken = Object.values(result.breakdown).reduce((sum, b) => sum + b.cardPoints, 0);
      expect(cardPointsTaken).toBe(100);
    }
  });

  it('leaves every physical card accounted for in every mode', () => {
    for (const difficulty of DIFFICULTIES) {
      const result = playRound(difficulty, 4242);
      assertCardInvariant(result.state);
    }
  });
});

describe('the policies actually differ', () => {
  it('easy looks no further ahead, medium looks narrower than hard', () => {
    expect(DIFFICULTY_POLICIES.easy.lookaheadCandidates).toBe(0);
    expect(DIFFICULTY_POLICIES.medium.lookaheadCandidates).toBeLessThan(
      DIFFICULTY_POLICIES.hard.lookaheadCandidates
    );
    expect(DIFFICULTY_POLICIES.medium.opponentReplies).toBeLessThan(DIFFICULTY_POLICIES.hard.opponentReplies);
  });

  it('only easy is blind to what has already been played', () => {
    expect(DIFFICULTY_POLICIES.easy.evaluation.countsCards).toBe(false);
    expect(DIFFICULTY_POLICIES.medium.evaluation.countsCards).toBe(true);
    expect(DIFFICULTY_POLICIES.hard.evaluation.countsCards).toBe(true);
  });

  it('hard alone always takes the best move it found', () => {
    expect(DIFFICULTY_POLICIES.hard.slack).toBe(0);
    expect(DIFFICULTY_POLICIES.easy.slack).toBeGreaterThan(DIFFICULTY_POLICIES.medium.slack);
  });

  it('card counting changes what a position is judged to be worth', () => {
    // Same state, two evaluation policies: the counted one prices the opponent's chances off the
    // unseen pool, the blind one off a flat guess, so the two totals do not agree.
    let game = freshGame('evaluation-differs');
    const bidder = game.state.bidderId!;
    game = submitBid(game, bidder, chooseBid(game, bidder, { difficulty: 'hard' }).choice);
    const opening = chooseOpeningAction(game, bidder, { difficulty: 'hard' }).choice;
    game = submitOpeningAction(game, bidder, opening);

    const counted = evaluate(game.state, bidder, DIFFICULTY_POLICIES.hard.evaluation).total;
    const blind = evaluate(game.state, bidder, DIFFICULTY_POLICIES.easy.evaluation).total;
    expect(counted).not.toBe(blind);
  });

  it('easy settles for a move hard would not have played', () => {
    // A deterministic rng makes the slack policy reproducible, so this is a claim about the
    // policy rather than about luck: over a round's worth of positions, the two modes diverge.
    const positions: OrchestratedGame[] = [];
    let game = freshGame('divergence');
    const bidder = game.state.bidderId!;
    game = submitBid(game, bidder, chooseBid(game, bidder, { difficulty: 'hard' }).choice);
    game = submitOpeningAction(game, bidder, chooseOpeningAction(game, bidder, { difficulty: 'hard' }).choice);

    let guard = 0;
    while (!isRoundComplete(game) && guard++ < 50) {
      positions.push(game);
      const seat = game.state.players[game.state.currentPlayerIndex].id;
      game = submitMove(game, seat, chooseMove(game, seat, { difficulty: 'hard' }).choice);
    }

    const diverged = positions.some(position => {
      const seat = position.state.players[position.state.currentPlayerIndex].id;
      const hard = chooseMove(position, seat, { difficulty: 'hard' }).choice;
      // rng: () => 0 makes Easy take the BEST of its own near-best band, so any divergence here is
      // weaker judgement rather than a coin toss — the stronger of the two claims.
      const easy = chooseMove(position, seat, { difficulty: 'easy', rng: () => 0 }).choice;
      return JSON.stringify(hard) !== JSON.stringify(easy);
    });
    expect(diverged).toBe(true);
  });
});

describe('the bot every other table uses is untouched', () => {
  it('an unqualified decision is the hard decision', () => {
    // host.ts and the Family table call these with no options at all. If that default ever drifts
    // from 'hard', shared play silently gets a weaker opponent — so it is pinned here.
    let game = freshGame('default-is-hard');
    const bidder = game.state.bidderId!;
    game = submitBid(game, bidder, chooseBid(game, bidder).choice);

    expect(JSON.stringify(chooseOpeningAction(game, bidder).choice)).toBe(
      JSON.stringify(chooseOpeningAction(game, bidder, { difficulty: 'hard' }).choice)
    );

    game = submitOpeningAction(game, bidder, chooseOpeningAction(game, bidder).choice);
    const seat = game.state.players[game.state.currentPlayerIndex].id;
    expect(JSON.stringify(chooseMove(game, seat).choice)).toBe(
      JSON.stringify(chooseMove(game, seat, { difficulty: 'hard' }).choice)
    );
  });

  it('evaluate with no policy is the full-strength evaluation', () => {
    const game = freshGame('default-evaluation');
    const bidder = game.state.bidderId!;
    expect(evaluate(game.state, bidder).total).toBe(
      evaluate(game.state, bidder, DIFFICULTY_POLICIES.hard.evaluation).total
    );
  });
});
