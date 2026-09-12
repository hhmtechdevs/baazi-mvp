import { describe, expect, it } from 'vitest';
import {
  cardPoints,
  completeRound,
  computeRoundScoreBreakdown,
  determineNextDealerSide,
  sweepPoints
} from './scoring';
import { advanceAfterMove } from './turnProgression';
import { createDeck } from './deck';
import type { Card, GameState, Player, SweepRecord, Team } from '../types';

function card(rank: Card['rank'], suit: Card['suit']): Card {
  return { id: `${rank}-${suit}`, rank, suit };
}

function makePlayer(id: string, opts: { hand?: Card[]; reserve?: Card[]; captured?: Card[] } = {}): Player {
  return { id, name: id, teamId: null, hand: opts.hand ?? [], reserve: opts.reserve ?? [], captured: opts.captured ?? [] };
}

function makeState(opts: {
  players: Player[];
  mode?: GameState['mode'];
  teams?: Team[];
  sweepRecords?: SweepRecord[];
  floorLoose?: Card[];
  phase?: GameState['phase'];
  roundNumber?: number;
  scores?: Record<string, number>;
  currentPlayerIndex?: number;
  history?: GameState['history'];
}): GameState {
  const floorLoose = opts.floorLoose ?? [];
  const used = new Set(
    [...opts.players.flatMap(p => [...p.hand, ...p.reserve, ...p.captured]), ...floorLoose].map(c => c.id)
  );
  const deck = createDeck().filter(c => !used.has(c.id));
  return {
    gameId: 'g',
    mode: opts.mode ?? '2player',
    roundNumber: opts.roundNumber ?? 1,
    players: opts.players,
    teams: opts.teams ?? [],
    floor: { loose: floorLoose, houses: [] },
    deck,
    phase: opts.phase ?? 'roundEnd',
    currentPlayerIndex: opts.currentPlayerIndex ?? 0,
    turnNumber: 0,
    bidValue: null,
    bidderId: null,
    sweepRecords: opts.sweepRecords ?? [],
    scores: opts.scores ?? {},
    roundScores: {},
    history: opts.history ?? []
  };
}

describe('card scoring', () => {
  it('all 13 spades score 91 in total', () => {
    const suits: Card['suit'][] = ['spades'];
    const ranks: Card['rank'][] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const total = suits.flatMap(s => ranks.map(r => card(r, s))).reduce((sum, c) => sum + cardPoints(c), 0);
    expect(total).toBe(91);
  });

  it('the four aces contribute exactly 4 points total, and A-spades is not double-counted', () => {
    const aceSpades = cardPoints(card('A', 'spades'));
    const aceHearts = cardPoints(card('A', 'hearts'));
    const aceDiamonds = cardPoints(card('A', 'diamonds'));
    const aceClubs = cardPoints(card('A', 'clubs'));
    expect(aceSpades).toBe(1); // counted once, as part of the 91 spade total
    expect(aceHearts).toBe(1);
    expect(aceDiamonds).toBe(1);
    expect(aceClubs).toBe(1);
    expect(aceSpades + aceHearts + aceDiamonds + aceClubs).toBe(4);
  });

  it('10-diamonds contributes 6', () => {
    expect(cardPoints(card('10', 'diamonds'))).toBe(6);
  });

  it('non-scoring cards contribute 0', () => {
    expect(cardPoints(card('10', 'clubs'))).toBe(0);
    expect(cardPoints(card('K', 'hearts'))).toBe(0);
    expect(cardPoints(card('9', 'diamonds'))).toBe(0);
    expect(cardPoints(card('2', 'diamonds'))).toBe(0);
  });

  it('total possible card points across the full 52-card deck is exactly 100', () => {
    const total = createDeck().reduce((sum, c) => sum + cardPoints(c), 0);
    expect(total).toBe(100);
  });
});

describe('sweeps', () => {
  const base: Omit<SweepRecord, 'isOpeningPlay' | 'isFinalPlay'> = { playerId: 'A', teamId: null, roundNumber: 1 };

  it('normal sweep = 50', () => {
    expect(sweepPoints({ ...base, isOpeningPlay: false, isFinalPlay: false })).toBe(50);
  });

  it('opening sweep = 25', () => {
    expect(sweepPoints({ ...base, isOpeningPlay: true, isFinalPlay: false })).toBe(25);
  });

  it('final-play sweep = 0', () => {
    expect(sweepPoints({ ...base, isOpeningPlay: false, isFinalPlay: true })).toBe(0);
  });

  it('a sweep on the second-to-last play is still a normal 50-point sweep (isFinalPlay only true for the literal last card)', () => {
    expect(sweepPoints({ ...base, isOpeningPlay: false, isFinalPlay: false })).toBe(50);
  });

  it('sweep does not grant an extra turn (Ingredient 6 behavior, exercised here as an integration check)', () => {
    // B needs a card, otherwise both hands are already empty and this would be end-of-play
    // rather than a mid-round "who plays next" check.
    let state = makeState({
      players: [makePlayer('A'), makePlayer('B', { hand: [card('3', 'hearts')] })],
      phase: 'playing',
      currentPlayerIndex: 0
    });
    state = advanceAfterMove(state, 'A', true);
    expect(state.players[state.currentPlayerIndex].id).toBe('B');
  });
});

describe('final loose floor -> last capturing side (integration with Ingredient 6)', () => {
  it('remaining loose floor cards contribute their scoring value to the last capturer, not the last player', () => {
    // A captured earlier (recorded in history) and is out of cards; B plays the literal last
    // card of the round (a throw). Ingredient 6 must award the leftover floor to A; Ingredient 7
    // must then score those cards as part of A's total.
    let state = makeState({
      players: [makePlayer('A'), makePlayer('B', { hand: [card('3', 'hearts')] })],
      floorLoose: [card('10', 'diamonds')], // worth 6
      history: [{ type: 'capture', playerId: 'A', payload: {}, timestamp: 0 }],
      phase: 'playing',
      currentPlayerIndex: 1
    });
    state = {
      ...state,
      players: state.players.map(p => (p.id === 'B' ? { ...p, hand: [] } : p)),
      floor: { ...state.floor, loose: [...state.floor.loose, card('3', 'hearts')] }
    };
    state = advanceAfterMove(state, 'B', false);
    expect(state.phase).toBe('roundEnd');

    const breakdown = computeRoundScoreBreakdown(state);
    expect(breakdown.A.cardPoints).toBe(6); // 10-diamonds, awarded to A despite B playing last
    expect(breakdown.B.cardPoints).toBe(0);
  });
});

describe('2-player', () => {
  it('individual scoring: each player is their own side', () => {
    const state = makeState({
      players: [
        makePlayer('A', { captured: [card('K', 'spades')] }), // 13
        makePlayer('B', { captured: [card('10', 'diamonds')] }) // 6
      ]
    });
    const breakdown = computeRoundScoreBreakdown(state);
    expect(breakdown.A.total).toBe(13);
    expect(breakdown.B.total).toBe(6);
  });

  it('cumulative scores carry across multiple completed rounds', () => {
    let state = makeState({
      players: [makePlayer('A', { captured: [card('K', 'spades')] }), makePlayer('B', { captured: [] })],
      roundNumber: 1
    });
    let result = completeRound(state, { type: 'fixedRounds', rounds: 3 });
    expect(result.state.scores).toEqual({ A: 13, B: 0 });
    expect(result.gameOver).toBe(false);

    state = makeState({
      players: [makePlayer('A', { captured: [] }), makePlayer('B', { captured: [card('Q', 'spades')] })],
      roundNumber: 2,
      scores: result.state.scores
    });
    result = completeRound(state, { type: 'fixedRounds', rounds: 3 });
    expect(result.state.scores).toEqual({ A: 13, B: 12 });
    expect(result.gameOver).toBe(false);
  });
});

describe('4-player', () => {
  const team0: Team = { id: 'team-0', name: 'Team 0', playerIds: ['A', 'C'] };
  const team1: Team = { id: 'team-1', name: 'Team 1', playerIds: ['B', 'D'] };

  it('team scoring: captured cards from either teammate count toward the team', () => {
    const state = makeState({
      mode: '4player',
      teams: [team0, team1],
      players: [
        makePlayer('A', { captured: [card('K', 'spades')] }), // 13, team-0
        makePlayer('B', { captured: [card('10', 'diamonds')] }), // 6, team-1
        makePlayer('C', { captured: [card('Q', 'spades')] }), // 12, team-0
        makePlayer('D', { captured: [] })
      ]
    });
    const breakdown = computeRoundScoreBreakdown(state);
    expect(breakdown['team-0'].cardPoints).toBe(25); // 13 + 12, from both teammates
    expect(breakdown['team-1'].cardPoints).toBe(6);
  });

  it('sweep points count for the team, derived from state.teams (not the unpopulated player.teamId/SweepRecord.teamId fields)', () => {
    const state = makeState({
      mode: '4player',
      teams: [team0, team1],
      players: [makePlayer('A'), makePlayer('B'), makePlayer('C'), makePlayer('D')],
      sweepRecords: [{ playerId: 'C', teamId: null, roundNumber: 1, isOpeningPlay: false, isFinalPlay: false }]
    });
    const breakdown = computeRoundScoreBreakdown(state);
    expect(breakdown['team-0'].sweepPoints).toBe(50); // C is on team-0
    expect(breakdown['team-1'].sweepPoints).toBe(0);
  });

  it('final loose cards go to the last capturing TEAM', () => {
    let state = makeState({
      mode: '4player',
      teams: [team0, team1],
      players: [
        makePlayer('A'),
        makePlayer('B', { hand: [card('3', 'hearts')] }),
        makePlayer('C'),
        makePlayer('D')
      ],
      floorLoose: [card('K', 'spades')], // 13, worth attributing correctly
      history: [{ type: 'capture', playerId: 'A', payload: {}, timestamp: 0 }], // A is on team-0
      phase: 'playing',
      currentPlayerIndex: 1
    });
    state = {
      ...state,
      players: state.players.map(p => (p.id === 'B' ? { ...p, hand: [] } : p)),
      floor: { ...state.floor, loose: [...state.floor.loose, card('3', 'hearts')] }
    };
    state = advanceAfterMove(state, 'B', false); // B (team-1) plays last, but A (team-0) captured last
    expect(state.phase).toBe('roundEnd');
    const breakdown = computeRoundScoreBreakdown(state);
    expect(breakdown['team-0'].cardPoints).toBe(13); // awarded to A's team despite B playing last
    expect(breakdown['team-1'].cardPoints).toBe(0);
  });

  it('cumulative team scoring across rounds', () => {
    let state = makeState({
      mode: '4player',
      teams: [team0, team1],
      players: [
        makePlayer('A', { captured: [card('K', 'spades')] }),
        makePlayer('B'),
        makePlayer('C'),
        makePlayer('D')
      ],
      roundNumber: 1
    });
    let result = completeRound(state, { type: 'fixedRounds', rounds: 2 });
    expect(result.state.scores).toEqual({ 'team-0': 13, 'team-1': 0 });

    state = makeState({
      mode: '4player',
      teams: [team0, team1],
      players: [makePlayer('A'), makePlayer('B', { captured: [card('10', 'diamonds')] }), makePlayer('C'), makePlayer('D')],
      roundNumber: 2,
      scores: result.state.scores
    });
    result = completeRound(state, { type: 'fixedRounds', rounds: 2 });
    expect(result.state.scores).toEqual({ 'team-0': 13, 'team-1': 6 });
    expect(result.gameOver).toBe(true); // 2 of 2 rounds complete
  });
});

describe('fixed rounds', () => {
  it('N=1 ends the game after one completed round', () => {
    const state = makeState({ players: [makePlayer('A'), makePlayer('B')], roundNumber: 1 });
    const result = completeRound(state, { type: 'fixedRounds', rounds: 1 });
    expect(result.gameOver).toBe(true);
    expect(result.state.phase).toBe('gameEnd');
  });

  it('N=3 does not end until the third completed round', () => {
    const makeRound = (n: number, scores: Record<string, number>) =>
      makeState({ players: [makePlayer('A'), makePlayer('B')], roundNumber: n, scores });

    let result = completeRound(makeRound(1, {}), { type: 'fixedRounds', rounds: 3 });
    expect(result.gameOver).toBe(false);
    result = completeRound(makeRound(2, result.state.scores), { type: 'fixedRounds', rounds: 3 });
    expect(result.gameOver).toBe(false);
    result = completeRound(makeRound(3, result.state.scores), { type: 'fixedRounds', rounds: 3 });
    expect(result.gameOver).toBe(true);
    expect(result.state.phase).toBe('gameEnd');
  });

  it('a tie at the final round produces a draw (equal cumulative scores, game still ends, no invented tie-break)', () => {
    const state = makeState({
      players: [makePlayer('A', { captured: [card('K', 'spades')] }), makePlayer('B', { captured: [card('Q', 'spades')] })],
      roundNumber: 1,
      scores: { A: 12, B: 13 } // going in: A=12+13(K)=25, B=13+12(Q)=25 -> tied after this round
    });
    const result = completeRound(state, { type: 'fixedRounds', rounds: 1 });
    expect(result.gameOver).toBe(true);
    expect(result.state.scores.A).toBe(result.state.scores.B); // a draw — Ingredient 7 does not declare a winner
    expect(result.nextDealerSide).toEqual({ tied: true }); // no invented tie-breaking dealer rule
  });

  it('no automatic extra round is added beyond the configured N', () => {
    const state = makeState({ players: [makePlayer('A'), makePlayer('B')], roundNumber: 3 });
    const result = completeRound(state, { type: 'fixedRounds', rounds: 3 });
    expect(result.gameOver).toBe(true); // ends exactly at N=3, nothing implies a 4th round
  });
});

describe('100-point lead', () => {
  it('a lead under 100 continues the game', () => {
    const state = makeState({ players: [makePlayer('A'), makePlayer('B')], scores: { A: 50, B: 0 }, roundNumber: 1 });
    const result = completeRound(state, { type: 'leadTarget', points: 100 });
    expect(result.gameOver).toBe(false);
  });

  it('a lead of exactly 100 ends the game after the completed round', () => {
    const exact = makeState({
      players: [makePlayer('A', { captured: [card('K', 'spades')] }), makePlayer('B')], // A: +13 this round
      scores: { A: 87, B: 0 } // A: 87+13=100, B: 0+0=0, lead=100
    });
    const result = completeRound(exact, { type: 'leadTarget', points: 100 });
    expect(result.state.scores.A - result.state.scores.B).toBe(100);
    expect(result.gameOver).toBe(true);
  });

  it('a lead greater than 100 ends the game after the completed round', () => {
    const state = makeState({
      players: [makePlayer('A', { captured: [card('K', 'spades')] }), makePlayer('B')],
      scores: { A: 100, B: 0 } // A: 100+13=113, B: 0, lead=113
    });
    const result = completeRound(state, { type: 'leadTarget', points: 100 });
    expect(result.gameOver).toBe(true);
  });

  it('never ends mid-round: completeRound requires phase to already be roundEnd', () => {
    const state = makeState({ players: [makePlayer('A'), makePlayer('B')], phase: 'playing' });
    expect(() => completeRound(state, { type: 'leadTarget', points: 100 })).toThrow(/Expected phase/);
  });
});

describe('no 9-point rule', () => {
  it('a side scoring 0 is valid and the game simply continues', () => {
    const state = makeState({ players: [makePlayer('A'), makePlayer('B')], roundNumber: 1 });
    const result = completeRound(state, { type: 'fixedRounds', rounds: 5 });
    expect(result.breakdown.A.total).toBe(0);
    expect(result.breakdown.B.total).toBe(0);
    expect(result.gameOver).toBe(false);
  });

  it('a side scoring 1 is valid', () => {
    const state = makeState({
      players: [makePlayer('A', { captured: [card('A', 'hearts')] }), makePlayer('B')],
      roundNumber: 1
    });
    const result = completeRound(state, { type: 'fixedRounds', rounds: 5 });
    expect(result.breakdown.A.total).toBe(1);
  });

  it('scoring below 9 does not cause an automatic loss or any special-case behavior', () => {
    const state = makeState({
      players: [makePlayer('A', { captured: [card('3', 'hearts'), card('A', 'clubs')] }), makePlayer('B')], // A: 0+1=1
      roundNumber: 5
    });
    const result = completeRound(state, { type: 'fixedRounds', rounds: 5 });
    expect(result.state.scores.A).toBe(1); // no penalty, no forced loss
    expect(result.gameOver).toBe(true); // ends because N=5 was reached, not because of the low score
  });
});

describe('next dealer side (rule 12)', () => {
  it('the trailing side is identified as the next dealer (leading side gets the calling advantage)', () => {
    expect(determineNextDealerSide({ A: 60, B: 20 })).toEqual({ side: 'B' });
  });

  it('a tie is reported rather than resolved by an invented rule', () => {
    expect(determineNextDealerSide({ A: 40, B: 40 })).toEqual({ tied: true });
  });
});
