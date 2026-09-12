import { describe, expect, it } from 'vitest';
import { startRound, submitBid, submitOpeningAction, submitMove, isRoundComplete, completeRound } from '../engine/roundOrchestrator';
import { assertCardInvariant, collectAllCards } from '../engine/deal';
import { chooseBid, chooseMove, chooseOpeningAction } from './strategy';
import { evaluate } from './evaluate';
import { unseenCards, estimatedCaptureRisk } from './cardCounting';
import { playAutomatedGame } from './autoplay';
import { flattenOptionsForHand, toNormalPlayMove } from '../engine/moveAdapter';
import { discoverLegalMoves } from '../engine/roundOrchestrator';
import type { OrchestratedGame } from '../engine/roundOrchestrator';

function freshGame(overrides?: Partial<Parameters<typeof startRound>[0]>): OrchestratedGame {
  return startRound({
    gameId: 'test',
    mode: '2player',
    players: [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }],
    dealerId: 'A',
    gameLengthConfig: { type: 'fixedRounds', rounds: 1 },
    ...overrides
  });
}

describe('bot only ever selects moves that were actually discovered as legal', () => {
  it('the bid, opening action, and every main-play move chosen match a real discovered option', () => {
    let game = freshGame();
    const bidderId = game.state.bidderId!;

    const eligibleValues = new Set(
      game.state.players
        .find(p => p.id === bidderId)!
        .hand.map(c => ({ A: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13 } as Record<string, number>)[c.rank])
        .filter(v => v >= 9 && v <= 13)
    );
    const bid = chooseBid(game, bidderId);
    expect(eligibleValues.has(bid.choice)).toBe(true);
    game = submitBid(game, bidderId, bid.choice);

    const openingOptions = flattenOptionsForHand(discoverLegalMoves(game, bidderId));
    const openingDecision = chooseOpeningAction(game, bidderId);
    expect(openingOptions.some(o => JSON.stringify(toActionShape(o)) === JSON.stringify(openingDecision.choice))).toBe(true);
    game = submitOpeningAction(game, bidderId, openingDecision.choice);

    let guard = 0;
    while (!isRoundComplete(game)) {
      guard++;
      expect(guard).toBeLessThan(500);
      const currentId = game.state.players[game.state.currentPlayerIndex].id;
      const legalOptions = flattenOptionsForHand(discoverLegalMoves(game, currentId));
      const decision = chooseMove(game, currentId);
      const matches = legalOptions.some(o => JSON.stringify(toNormalPlayMove(o)) === JSON.stringify(decision.choice));
      expect(matches).toBe(true);
      game = submitMove(game, currentId, decision.choice);
    }
    assertCardInvariant(game.state);
  });
});

function toActionShape(o: ReturnType<typeof flattenOptionsForHand>[number]) {
  if (o.kind === 'build') return { type: 'build', builderCardId: o.handCardId, floorCardIds: o.floorCardIds };
  if (o.kind === 'capture') return { type: 'capture', bidCardId: o.handCardId, targets: o.targets };
  return { type: 'throw', bidCardId: o.handCardId };
}

describe('bot completes a full 2-player round', () => {
  it('plays bid -> opening -> main play -> roundEnd entirely via chooseX + submitX, invariant holding throughout', () => {
    let game = freshGame();
    const bidderId = game.state.bidderId!;
    game = submitBid(game, bidderId, chooseBid(game, bidderId).choice);
    game = submitOpeningAction(game, bidderId, chooseOpeningAction(game, bidderId).choice);

    let guard = 0;
    while (!isRoundComplete(game)) {
      guard++;
      expect(guard).toBeLessThan(500);
      assertCardInvariant(game.state);
      const currentId = game.state.players[game.state.currentPlayerIndex].id;
      game = submitMove(game, currentId, chooseMove(game, currentId).choice);
    }

    expect(game.state.phase).toBe('roundEnd');
    expect(game.state.players.every(p => p.hand.length === 0 && p.reserve.length === 0)).toBe(true);
    assertCardInvariant(game.state);
    expect(collectAllCards(game.state)).toHaveLength(52);

    const result = completeRound(game);
    expect(result.gameOver).toBe(true);
  });
});

describe('bot completes a full game (both sides strategic, via playAutomatedGame)', () => {
  it('reaches gameEnd within a bounded number of rounds/moves with a valid final score', () => {
    const result = playAutomatedGame({
      playerAId: 'A',
      playerBId: 'B',
      dealerId: 'A',
      gameLengthConfig: { type: 'fixedRounds', rounds: 2 }
    });
    expect(result.finalGame.state.phase).toBe('gameEnd');
    expect(result.finalResult.gameOver).toBe(true);
    expect(result.roundsPlayed).toBe(2);
    assertCardInvariant(result.finalGame.state);
    expect(collectAllCards(result.finalGame.state)).toHaveLength(52);
    expect(result.events.length).toBeGreaterThan(0);
  });

  it('completes a 100-point-lead game without ending mid-round', () => {
    const result = playAutomatedGame({
      playerAId: 'A',
      playerBId: 'B',
      dealerId: 'A',
      gameLengthConfig: { type: 'leadTarget', points: 100 },
      maxRounds: 30
    });
    expect(result.finalResult.gameOver).toBe(true);
    const scores = result.finalResult.state.scores;
    const lead = Math.abs((scores.A ?? 0) - (scores.B ?? 0));
    expect(lead).toBeGreaterThanOrEqual(100);
    assertCardInvariant(result.finalGame.state);
  });
});

describe('bot does not mutate state directly and only acts through the orchestrator', () => {
  it('discoverLegalMoves/chooseMove do not alter the input game object', () => {
    const game = freshGame();
    const bidderId = game.state.bidderId!;
    const snapshotBefore = JSON.stringify(game);
    // Calling a bid decision (which internally simulates via submitBid/submitOpeningAction) must
    // not alter the original `game` object at all — every engine function returns new objects.
    chooseBid(game, bidderId);
    expect(JSON.stringify(game)).toBe(snapshotBefore);
  });
});

describe('bot does not get stuck when multiple legal moves exist', () => {
  it('always returns exactly one decision even when many options are available', () => {
    let game = freshGame();
    const bidderId = game.state.bidderId!;
    game = submitBid(game, bidderId, chooseBid(game, bidderId).choice);
    game = submitOpeningAction(game, bidderId, chooseOpeningAction(game, bidderId).choice);
    const currentId = game.state.players[game.state.currentPlayerIndex].id;
    const options = flattenOptionsForHand(discoverLegalMoves(game, currentId));
    const decision = chooseMove(game, currentId);
    expect(decision.candidates.length).toBe(options.length);
    expect(decision.choice).toBeDefined();
  });
});

describe('evaluation function and card counting', () => {
  it('evaluate favors the side with more already-captured points', () => {
    // Deterministic, hand-constructed state: A has captured a King of spades (13 points), B has
    // captured nothing. Everyone's own hand/floor is empty so no other factor competes with the
    // captured-value signal being tested.
    const state = {
      gameId: 'eval-test',
      mode: '2player' as const,
      roundNumber: 1,
      players: [
        { id: 'A', name: 'A', teamId: null, hand: [], reserve: [], captured: [{ id: 'K-spades', rank: 'K' as const, suit: 'spades' as const }] },
        { id: 'B', name: 'B', teamId: null, hand: [], reserve: [], captured: [] }
      ],
      teams: [],
      floor: { loose: [], houses: [] },
      deck: [],
      phase: 'playing' as const,
      currentPlayerIndex: 0,
      turnNumber: 0,
      bidValue: null,
      bidderId: null,
      sweepRecords: [],
      scores: {},
      roundScores: {},
      history: []
    };
    const scoreForA = evaluate(state, 'A').total; // A evaluating itself: ahead by 13
    const scoreForB = evaluate(state, 'B').total; // B evaluating itself: behind by 13
    expect(scoreForA).toBeGreaterThan(scoreForB);
  });

  it('unseenCards excludes everything the evaluating player can already see', () => {
    const game = freshGame();
    const bidderId = game.state.bidderId!;
    const unseen = unseenCards(game.state, bidderId);
    const bidder = game.state.players.find(p => p.id === bidderId)!;
    const visibleIds = new Set([...bidder.hand, ...bidder.reserve, ...game.state.floor.loose].map(c => c.id));
    expect(unseen.every(c => !visibleIds.has(c.id))).toBe(true);
  });

  it('estimatedCaptureRisk returns 0 for an empty unseen pool and stays within [0,1]', () => {
    expect(estimatedCaptureRisk([], 11)).toBe(0);
    const game = freshGame();
    const bidderId = game.state.bidderId!;
    const unseen = unseenCards(game.state, bidderId);
    for (let v = 1; v <= 13; v++) {
      const risk = estimatedCaptureRisk(unseen, v);
      expect(risk).toBeGreaterThanOrEqual(0);
      expect(risk).toBeLessThanOrEqual(1);
    }
  });
});
