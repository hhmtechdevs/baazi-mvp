import { describe, expect, it } from 'vitest';
import { advanceAfterMove, advanceAfterOpeningAction } from './turnProgression';
import { assertCardInvariant } from './deal';
import { createDeck } from './deck';
import type { Card, GameState, Player } from '../types';

function card(rank: Card['rank'], suit: Card['suit']): Card {
  return { id: `${rank}-${suit}`, rank, suit };
}

function makePlayer(id: string, hand: Card[], opts: { reserve?: Card[]; captured?: Card[] } = {}): Player {
  return { id, name: id, teamId: null, hand, reserve: opts.reserve ?? [], captured: opts.captured ?? [] };
}

/**
 * Builds a full, invariant-satisfying GameState. Any canonical deck cards not explicitly placed
 * end up in `deck`, never in a hand, so the 52-card invariant is meaningful across every test.
 * `currentPlayerIndex` must be passed explicitly and must match whoever the test is about to pass
 * as the acting player to advanceAfterMove/advanceAfterOpeningAction — these functions trust it as
 * "who just acted" exactly as executeMove already guarantees in the real flow; a direct unit test
 * of turnProgression.ts must establish that precondition itself.
 */
function makeState(opts: {
  players: Player[];
  floorLoose?: Card[];
  mode?: GameState['mode'];
  currentPlayerIndex: number;
  turnNumber?: number;
  bidderId?: string | null;
  history?: GameState['history'];
}): GameState {
  const floorLoose = opts.floorLoose ?? [];
  const used = new Set(
    [...opts.players.flatMap(p => [...p.hand, ...p.reserve, ...p.captured]), ...floorLoose].map(c => c.id)
  );
  const deck = createDeck().filter(c => !used.has(c.id));
  return {
    gameId: 'g',
    mode: opts.mode ?? '4player',
    roundNumber: 1,
    players: opts.players,
    teams: [],
    floor: { loose: floorLoose, houses: [] },
    deck,
    phase: 'playing',
    currentPlayerIndex: opts.currentPlayerIndex,
    turnNumber: opts.turnNumber ?? 0,
    bidValue: null,
    bidderId: opts.bidderId ?? null,
    sweepRecords: [],
    scores: {},
    roundScores: {},
    history: opts.history ?? []
  };
}

/** Simulates "playerId just threw their card onto the floor" — a physically honest relocation
 * (hand -> floor.loose), unlike simply setting hand to [] which would delete the card from
 * existence and trip the 52-card invariant in tests that check it. */
function simulateThrow(state: GameState, playerId: string, cardId: string): GameState {
  const player = state.players.find(p => p.id === playerId)!;
  const played = player.hand.find(c => c.id === cardId)!;
  return {
    ...state,
    players: state.players.map(p => (p.id === playerId ? { ...p, hand: p.hand.filter(c => c.id !== cardId) } : p)),
    floor: { ...state.floor, loose: [...state.floor.loose, played] }
  };
}

describe('1. four-player turn order', () => {
  it('A -> B -> C -> D -> A, verified after each move, by actual identity not just index', () => {
    // Two cards each so a full lap (A,B,C,D,A) can be observed before anyone empties out.
    let state = makeState({
      players: [
        makePlayer('A', [card('2', 'hearts'), card('2', 'clubs')]),
        makePlayer('B', [card('3', 'hearts'), card('3', 'clubs')]),
        makePlayer('C', [card('4', 'hearts'), card('4', 'clubs')]),
        makePlayer('D', [card('5', 'hearts'), card('5', 'clubs')])
      ],
      currentPlayerIndex: 0
    });
    const order = ['A', 'B', 'C', 'D', 'A'];
    for (let i = 0; i < 4; i++) {
      const actingId = order[i];
      state = simulateThrow(state, actingId, state.players.find(p => p.id === actingId)!.hand[0].id);
      state = { ...state, currentPlayerIndex: i };
      state = advanceAfterMove(state, actingId, false);
      const expectedNextId = order[i + 1];
      expect(state.players[state.currentPlayerIndex].id).toBe(expectedNextId);
      expect(state.phase).toBe('playing'); // not over yet — everyone still holds a second card
    }
  });
});

describe('2. two-player turn order', () => {
  it('A -> B -> A -> B', () => {
    let state = makeState({
      players: [makePlayer('A', [card('2', 'hearts'), card('3', 'hearts')]), makePlayer('B', [card('4', 'hearts'), card('5', 'hearts')])],
      mode: '2player',
      currentPlayerIndex: 0
    });
    state = simulateThrow(state, 'A', '2-hearts');
    state = advanceAfterMove(state, 'A', false);
    expect(state.players[state.currentPlayerIndex].id).toBe('B');
    state = simulateThrow(state, 'B', '4-hearts');
    state = advanceAfterMove(state, 'B', false);
    expect(state.players[state.currentPlayerIndex].id).toBe('A');
  });
});

describe('3. sweep does not grant an extra turn', () => {
  it('A sweeps; B becomes current player, not A again', () => {
    let state = makeState({
      players: [makePlayer('A', [card('2', 'hearts')]), makePlayer('B', [card('3', 'hearts')])],
      mode: '2player',
      currentPlayerIndex: 0
    });
    // A "sweeps" (a capture that empties the floor) — the card leaves A's hand into `captured`,
    // exactly as executeCapture (Ingredient 5) already does; the sweep record itself is
    // Ingredient 5's concern and is not re-tested here, only that no extra turn is granted.
    state = {
      ...state,
      players: state.players.map(p => (p.id === 'A' ? { ...p, hand: [], captured: [...p.captured, card('2', 'hearts')] } : p))
    };
    state = advanceAfterMove(state, 'A', true);
    expect(state.players[state.currentPlayerIndex].id).toBe('B');
  });
});

describe('4. one player empty in 4-player', () => {
  it('A is already empty; play continues with B, C, D (A is skipped, never dealt a turn)', () => {
    let state = makeState({
      players: [
        makePlayer('A', []), // already empty — simulates A having played their last card earlier
        makePlayer('B', [card('3', 'hearts')]),
        makePlayer('C', [card('4', 'hearts')]),
        makePlayer('D', [card('5', 'hearts')])
      ],
      currentPlayerIndex: 3 // D is acting
    });
    state = simulateThrow(state, 'D', '5-hearts');
    state = advanceAfterMove(state, 'D', false);
    expect(state.players[state.currentPlayerIndex].id).toBe('B'); // A is skipped entirely
  });
});

describe('5. all four hands empty', () => {
  it('transitions to roundEnd', () => {
    let state = makeState({
      players: [makePlayer('A', []), makePlayer('B', []), makePlayer('C', [card('4', 'hearts')]), makePlayer('D', [])],
      currentPlayerIndex: 1 // B is acting; C still has a card, not yet the end
    });
    state = advanceAfterMove(state, 'B', false);
    expect(state.phase).toBe('playing');
    expect(state.players[state.currentPlayerIndex].id).toBe('C');
    state = simulateThrow(state, 'C', '4-hearts');
    state = advanceAfterMove(state, 'C', false); // now every hand is empty
    expect(state.phase).toBe('roundEnd');
  });
});

describe('6. two-player first-hand transition (do not switch individually)', () => {
  it("A's first hand empties while B still has cards: A does NOT activate reserve, B continues, turn order intact", () => {
    let state = makeState({
      players: [
        makePlayer('A', [card('2', 'hearts')], { reserve: [card('9', 'hearts'), card('10', 'hearts')] }),
        makePlayer('B', [card('3', 'hearts')], { reserve: [card('J', 'hearts'), card('Q', 'hearts')] })
      ],
      mode: '2player',
      currentPlayerIndex: 0
    });
    state = simulateThrow(state, 'A', '2-hearts');
    state = advanceAfterMove(state, 'A', false);
    const a = state.players.find(p => p.id === 'A')!;
    expect(a.hand).toHaveLength(0); // NOT activated yet
    expect(a.reserve).toHaveLength(2); // untouched
    expect(state.players[state.currentPlayerIndex].id).toBe('B'); // turn order intact
    expect(state.phase).toBe('playing');
  });
});

describe('7. both two-player first hands empty', () => {
  it('both reserves activate simultaneously, floor unchanged, turn order intact, play remains active', () => {
    const looseBefore = [card('7', 'clubs'), card('8', 'diamonds')];
    let state = makeState({
      players: [
        makePlayer('A', [], { reserve: [card('9', 'hearts'), card('10', 'hearts')] }), // A already emptied earlier
        makePlayer('B', [card('3', 'hearts')], { reserve: [card('J', 'hearts'), card('Q', 'hearts')] })
      ],
      mode: '2player',
      floorLoose: looseBefore,
      currentPlayerIndex: 1 // B is acting
    });
    state = simulateThrow(state, 'B', '3-hearts'); // B's last first-hand card
    state = advanceAfterMove(state, 'B', false); // both first hands now empty

    const a = state.players.find(p => p.id === 'A')!;
    const b = state.players.find(p => p.id === 'B')!;
    expect(a.hand.map(c => c.id).sort()).toEqual(['10-hearts', '9-hearts'].sort());
    expect(a.reserve).toHaveLength(0);
    expect(b.hand.map(c => c.id).sort()).toEqual(['J-hearts', 'Q-hearts'].sort());
    expect(b.reserve).toHaveLength(0);
    expect(state.floor.loose.map(c => c.id).sort()).toEqual(
      [...looseBefore.map(c => c.id), '3-hearts'].sort() // untouched except for B's own throw
    );
    expect(state.players[state.currentPlayerIndex].id).toBe('A'); // established order (...A,B,A...) continues
    expect(state.phase).toBe('playing'); // still active, not roundEnd
  });
});

describe('8. two-player reserve play', () => {
  it('A and B alternate normally using their reserve cards', () => {
    let state = makeState({
      players: [makePlayer('A', [card('9', 'hearts'), card('10', 'hearts')]), makePlayer('B', [card('J', 'hearts')])],
      mode: '2player',
      currentPlayerIndex: 0
    });
    state = simulateThrow(state, 'A', '9-hearts');
    state = advanceAfterMove(state, 'A', false);
    expect(state.players[state.currentPlayerIndex].id).toBe('B');
    state = simulateThrow(state, 'B', 'J-hearts');
    state = advanceAfterMove(state, 'B', false);
    expect(state.players[state.currentPlayerIndex].id).toBe('A'); // A still has 10-hearts left
    expect(state.phase).toBe('playing');
  });
});

describe('9. two-player second phase ends', () => {
  it('both reserves (now hands) exhausted -> transitions to roundEnd', () => {
    let state = makeState({
      players: [makePlayer('A', []), makePlayer('B', [card('K', 'hearts')])],
      mode: '2player',
      currentPlayerIndex: 1 // B acting; A already empty (no reserve left for either)
    });
    state = simulateThrow(state, 'B', 'K-hearts');
    state = advanceAfterMove(state, 'B', false); // now both empty, no reserve left anywhere
    expect(state.phase).toBe('roundEnd');
  });
});

describe('10. final loose-floor transfer to the LAST CAPTURER, not the last player', () => {
  it('the last player to play is not necessarily the last to capture — floor goes to the capturer', () => {
    // A captured earlier in the hand (recorded in history) and is now out of cards; B plays the
    // literal final card of the round (a throw, not a capture). The leftover floor cards must go
    // to A (the last capturer), not to B (the last player).
    let state = makeState({
      players: [makePlayer('A', []), makePlayer('B', [card('3', 'hearts')])],
      mode: '2player',
      floorLoose: [card('7', 'clubs'), card('8', 'diamonds')],
      history: [{ type: 'capture', playerId: 'A', payload: {}, timestamp: 0 }],
      currentPlayerIndex: 1 // B is acting
    });
    state = simulateThrow(state, 'B', '3-hearts'); // B's final move — not itself a capture
    state = advanceAfterMove(state, 'B', false);
    expect(state.phase).toBe('roundEnd');
    const a = state.players.find(p => p.id === 'A')!;
    const b = state.players.find(p => p.id === 'B')!;
    // Everything left loose at end-of-play (the pre-existing 7/8 AND B's own final throw) goes to
    // A, the last capturer — even though B was the last to actually play a card.
    expect(a.captured.map(c => c.id).sort()).toEqual(['3-hearts', '7-clubs', '8-diamonds']);
    expect(b.captured).toHaveLength(0);
    expect(state.floor.loose).toHaveLength(0);
  });

  it('if nobody ever captured, leftover cards are left exactly where they are (no invented rule)', () => {
    let state = makeState({
      players: [makePlayer('A', [card('2', 'hearts')]), makePlayer('B', [])],
      mode: '2player',
      floorLoose: [card('7', 'clubs')],
      history: [],
      currentPlayerIndex: 0
    });
    state = simulateThrow(state, 'A', '2-hearts');
    state = advanceAfterMove(state, 'A', false);
    expect(state.phase).toBe('roundEnd');
    expect(state.floor.loose.map(c => c.id).sort()).toEqual(['2-hearts', '7-clubs'].sort()); // untouched, not awarded to anyone
    expect(state.players.every(p => p.captured.length === 0)).toBe(true);
  });
});

describe('11. no scoring', () => {
  it('scores and roundScores are never touched by progression, even at roundEnd', () => {
    let state = makeState({
      players: [makePlayer('A', [card('2', 'hearts')]), makePlayer('B', [])],
      mode: '2player',
      currentPlayerIndex: 0
    });
    state = { ...state, scores: { A: 40, B: 15 }, roundScores: { A: 10, B: 5 } };
    state = simulateThrow(state, 'A', '2-hearts');
    state = advanceAfterMove(state, 'A', false);
    expect(state.phase).toBe('roundEnd');
    expect(state.scores).toEqual({ A: 40, B: 15 });
    expect(state.roundScores).toEqual({ A: 10, B: 5 });
  });
});

describe('12. physical card invariant', () => {
  it('holds after normal advancement, reserve activation, and final floor collection', () => {
    let state = makeState({
      players: [
        makePlayer('A', [], { reserve: [card('9', 'hearts')] }), // A already empty
        makePlayer('B', [card('3', 'hearts')], { reserve: [card('J', 'hearts')] })
      ],
      mode: '2player',
      floorLoose: [card('7', 'clubs')],
      history: [{ type: 'capture', playerId: 'B', payload: {}, timestamp: 0 }],
      currentPlayerIndex: 1
    });
    // B plays their last first-hand card -> both reserves activate.
    state = simulateThrow(state, 'B', '3-hearts');
    state = advanceAfterMove(state, 'B', false);
    assertCardInvariant(state);
    expect(state.phase).toBe('playing');

    // Reserve phase: A then B play their (now-active) reserve cards, ending the round.
    state = simulateThrow(state, 'A', '9-hearts');
    state = advanceAfterMove(state, 'A', false);
    assertCardInvariant(state);

    state = simulateThrow(state, 'B', 'J-hearts');
    state = advanceAfterMove(state, 'B', false);
    assertCardInvariant(state);
    expect(state.phase).toBe('roundEnd');
  });
});

describe('13. opening transition', () => {
  it('bidder opens; next player is derived from bidderId, not from a pre-set currentPlayerIndex', () => {
    const state = makeState({
      players: [
        makePlayer('dealer', [card('2', 'hearts')]),
        makePlayer('bidder', [card('3', 'hearts')]),
        makePlayer('p3', [card('4', 'hearts')]),
        makePlayer('p4', [card('5', 'hearts')])
      ],
      currentPlayerIndex: 3, // deliberately WRONG / stale, to prove it is not relied upon
      bidderId: 'bidder',
      turnNumber: 0
    });
    const next = advanceAfterOpeningAction(state, false);
    expect(next.players[next.currentPlayerIndex].id).toBe('p3'); // seat to the bidder's right
  });

  it('the bidder does not immediately get another turn', () => {
    const state = makeState({
      players: [makePlayer('bidder', [card('2', 'hearts')]), makePlayer('other', [card('3', 'hearts')])],
      mode: '2player',
      bidderId: 'bidder',
      currentPlayerIndex: 0
    });
    const next = advanceAfterOpeningAction(state, false);
    expect(next.players[next.currentPlayerIndex].id).not.toBe('bidder');
  });
});

describe('14. no double advancement', () => {
  it('one completed move advances turnNumber by exactly 1', () => {
    let state = makeState({
      players: [makePlayer('A', [card('2', 'hearts')]), makePlayer('B', [card('3', 'hearts')])],
      mode: '2player',
      turnNumber: 5,
      currentPlayerIndex: 0
    });
    state = simulateThrow(state, 'A', '2-hearts');
    state = advanceAfterMove(state, 'A', false);
    expect(state.turnNumber).toBe(6);
  });

  it('the opening bridge also advances turnNumber by exactly 1', () => {
    const state = makeState({
      players: [makePlayer('bidder', [card('2', 'hearts')]), makePlayer('other', [card('3', 'hearts')])],
      mode: '2player',
      bidderId: 'bidder',
      turnNumber: 0,
      currentPlayerIndex: 0
    });
    const next = advanceAfterOpeningAction(state, false);
    expect(next.turnNumber).toBe(1);
  });
});

describe('important edge case: 2-player, both players holding exactly one card', () => {
  it('A plays and empties; B still has one; A does NOT switch to reserve; B plays; only then both reserves activate; turn order intact', () => {
    let state = makeState({
      players: [
        makePlayer('A', [card('2', 'hearts')], { reserve: [card('9', 'hearts')] }),
        makePlayer('B', [card('3', 'hearts')], { reserve: [card('10', 'hearts')] })
      ],
      mode: '2player',
      currentPlayerIndex: 0
    });

    // A plays their one card.
    state = simulateThrow(state, 'A', '2-hearts');
    state = advanceAfterMove(state, 'A', false);
    let a = state.players.find(p => p.id === 'A')!;
    expect(a.hand).toHaveLength(0);
    expect(a.reserve).toHaveLength(1); // NOT activated yet
    expect(state.players[state.currentPlayerIndex].id).toBe('B');
    expect(state.phase).toBe('playing');

    // B plays their one card -> both first hands now exhausted.
    state = simulateThrow(state, 'B', '3-hearts');
    state = advanceAfterMove(state, 'B', false);
    a = state.players.find(p => p.id === 'A')!;
    const b = state.players.find(p => p.id === 'B')!;
    expect(a.hand.map(c => c.id)).toEqual(['9-hearts']); // activated
    expect(b.hand.map(c => c.id)).toEqual(['10-hearts']); // activated
    expect(state.players[state.currentPlayerIndex].id).toBe('A'); // established order (...A,B,A...) continues
    expect(state.phase).toBe('playing');
    assertCardInvariant(state);
  });
});
