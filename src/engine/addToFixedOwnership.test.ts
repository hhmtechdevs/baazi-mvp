import { describe, expect, it } from 'vitest';
import { discoverLegalOptions } from './legalMoves';
import { executeMove } from './moveExecution';
import { createDeck } from './deck';
import type { Card, GameState, House, Player } from '../types';

/**
 * REPORTED FROM LIVE FAMILY PLAY, 2026-10-07 (table CC3X, round 1) — TWICE in one round.
 *
 * Add-to-Fixed is offered onto an OPPONENT'S CEMENTED house that the acting side holds no card to
 * capture. Ownership does not change (frozen: "Add-to-Fixed never changes either"), the house
 * cannot be broken because it is cemented, and nobody on the acting side holds the capture value —
 * so the move hands the played card AND floor cards to the opponent for nothing at all.
 *
 * The existing retains-check only fires when the played card ALONE matches the house value
 * (`needed === 0`). Every offer below reaches the value THROUGH floor cards, so no check applies.
 *
 * FIXED 2026-10-07 by Product Owner decision. The rule is now:
 *
 *   A player may add to a cemented house only if their SIDE retains at least one card matching
 *   that house's capture value — a teammate's card counts — whether the played card reaches the
 *   value by itself or by combining with floor cards.
 *
 * Deliberately NOT expressed as a prohibition on opponents' houses: the game does not care who
 * owns the house, only whether the acting side has a legitimate path to collecting it. One rule,
 * no special cases. See ADD_TO_FIXED_OWNERSHIP.md.
 */

const card = (rank: Card['rank'], suit: Card['suit']): Card => ({ id: `${rank}-${suit}`, rank, suit });
const player = (id: string, hand: Card[]): Player => ({ id, name: id, teamId: null, hand, reserve: [], captured: [] });

const OPPONENT_THIRTEEN: House = {
  id: 'house-right-13',
  ownerSides: ['right'],
  cards: [card('5', 'diamonds'), card('K', 'diamonds'), card('8', 'diamonds')],
  captureValue: 13,
  isCemented: true
};

/** The table as it stood at turn 39: you to play, three cards, no 13 anywhere on your side. */
function turn39(): GameState {
  const you = [card('9', 'clubs'), card('6', 'clubs'), card('10', 'clubs')];
  const partner = [card('5', 'spades'), card('6', 'spades')];
  const left = [card('J', 'spades'), card('8', 'spades')];
  const right = [card('K', 'spades'), card('Q', 'spades')];
  const loose = [card('7', 'spades'), card('A', 'spades')];
  const used = new Set([...you, ...partner, ...left, ...right, ...loose, ...OPPONENT_THIRTEEN.cards].map(c => c.id));

  return {
    gameId: 'CC3X', mode: '4player', roundNumber: 1,
    players: [player('you', you), player('left', left), player('partner', partner), player('right', right)],
    teams: [
      { id: 'team-0', name: 'Team 0', playerIds: ['you', 'partner'] },
      { id: 'team-1', name: 'Team 1', playerIds: ['left', 'right'] }
    ],
    floor: { loose, houses: [OPPONENT_THIRTEEN] },
    deck: createDeck().filter(c => !used.has(c.id)),
    phase: 'playing', currentPlayerIndex: 0, turnNumber: 39,
    bidValue: 12, bidderId: 'left', sweepRecords: [], scores: {}, roundScores: {}, history: []
  };
}

/**
 * Puts a different hand into a named seat, rebuilding the deck so the 52-card invariant still
 * holds — the engine checks it on every move, so a fixture that simply swaps cards in fails for
 * the wrong reason.
 */
function handing(state: GameState, playerId: string, hand: Card[]): GameState {
  const players = state.players.map(p => (p.id === playerId ? { ...p, hand } : p));
  const inPlay = new Set([
    ...players.flatMap(p => [...p.hand, ...p.reserve, ...p.captured].map(c => c.id)),
    ...state.floor.loose.map(c => c.id),
    ...state.floor.houses.flatMap(h => h.cards.map(c => c.id))
  ]);
  return { ...state, players, deck: createDeck().filter(c => !inPlay.has(c.id)) };
}

describe('adding to a cemented house requires your side to hold its key', () => {
  it('REFUSES the reported move: 6♣ + 7♠ = 13 with no King on our side', () => {
    const state = turn39();
    const ourSide = ['you', 'partner'].flatMap(id => state.players.find(p => p.id === id)!.hand);
    expect(ourSide.some(c => c.rank === 'K')).toBe(false);

    expect(discoverLegalOptions(state, 'you', '6-clubs').some(o => o.kind === 'addToFixed')).toBe(false);
  });

  it('refuses it for every other card that could reach 13 through the floor', () => {
    // At turn 31 the same house was reachable four different ways. None of them may stand.
    const state = turn39();
    for (const id of ['9-clubs', '10-clubs']) {
      expect(discoverLegalOptions(state, 'you', id).some(o => o.kind === 'addToFixed'), id).toBe(false);
    }
  });

  it('ALLOWS it once you hold a King yourself, even though the house is the opponent\'s', () => {
    // Ownership is deliberately not what the rule turns on — having a path to collect it is.
    const state = handing(turn39(), 'you', [card('6', 'clubs'), card('K', 'clubs')]);
    const add = discoverLegalOptions(state, 'you', '6-clubs').find(o => o.kind === 'addToFixed');

    expect(add).toBeDefined();
    expect(add!.existingHouseId).toBe('house-right-13');
    expect(add!.floorCardIds).toEqual(['7-spades']);
  });

  it('REFUSES it when only your PARTNER holds the King — the key must be your own', () => {
    // REVERSED 2026-10-07 (Product Owner), after live play. A side-wide key let the table offer a
    // move whose justification sat in a hand the player could not see, which read as a bug every
    // time it happened. The key must be in the hand of whoever is playing.
    let state = handing(turn39(), 'you', [card('6', 'clubs'), card('9', 'clubs')]);
    state = handing(state, 'partner', [card('K', 'clubs'), card('5', 'spades')]);

    expect(discoverLegalOptions(state, 'you', '6-clubs').some(o => o.kind === 'addToFixed')).toBe(false);
  });

  it('still refuses a lone King reinforcing with no second King kept back', () => {
    // The case the old rule already covered, unchanged: playing your only key strands your own
    // ability to collect the house.
    const state = handing(turn39(), 'you', [card('K', 'clubs'), card('9', 'clubs')]);
    expect(discoverLegalOptions(state, 'you', 'K-clubs').some(o => o.kind === 'addToFixed')).toBe(false);
  });

  it('executes when the key is held, and BUYS INTO the house — red becomes purple', () => {
    const state = handing(turn39(), 'you', [card('6', 'clubs'), card('K', 'clubs')]);
    const add = discoverLegalOptions(state, 'you', '6-clubs').find(o => o.kind === 'addToFixed')!;
    const after = executeMove(state, 'you', {
      kind: 'addToFixed',
      handCardId: '6-clubs',
      existingHouseId: add.existingHouseId,
      floorCardIds: add.floorCardIds,
      absorbedLooseCardIds: add.absorbedLooseCardIds
    });

    const house = after.floor.houses.find(h => h.id === 'house-right-13')!;
    expect(house.cards.map(c => c.id)).toContain('7-spades');
    expect(house.cards.map(c => c.id)).toContain('6-clubs');
    // Bringing your own key buys you in: both sides now own it (Pagat). The owner is recorded as a
    // SIDE — `right` resolves to team-1 — which is how Cement has always stored joint ownership.
    expect(house.ownerSides.sort()).toEqual(['team-0', 'team-1']);
    expect(house.isCemented).toBe(true); // a fixed house stays fixed
  });
});

// ---------------------------------------------------------------------------
// Regression audit of the revised rule, 2026-10-07 — the arms not already covered above.
// ---------------------------------------------------------------------------

/** A two-handed table with one cemented 11-house, owned by whoever is named. */
function twoHanded(opts: { hand: Card[]; opponentHand?: Card[]; houseOwner?: string }): GameState {
  const house: House = {
    id: 'house-11',
    ownerSides: [opts.houseOwner ?? 'p2'],
    cards: [card('9', 'clubs'), card('2', 'clubs')],
    captureValue: 11,
    isCemented: true
  };
  const loose = [card('6', 'spades')];
  const opponent = opts.opponentHand ?? [];
  const used = new Set([...opts.hand, ...opponent, ...loose, ...house.cards].map(c => c.id));

  return {
    gameId: '2p', mode: '2player', roundNumber: 1,
    players: [player('p1', opts.hand), player('p2', opponent)],
    teams: [],
    floor: { loose, houses: [house] },
    deck: createDeck().filter(c => !used.has(c.id)),
    phase: 'playing', currentPlayerIndex: 0, turnNumber: 9,
    bidValue: null, bidderId: null, sweepRecords: [], scores: {}, roundScores: {}, history: []
  };
}

describe('the revised rule in two-handed play', () => {
  it('ALLOWS it when you hold the key yourself — 5♥ + 6♠ = 11, with a Jack kept back', () => {
    const state = twoHanded({ hand: [card('5', 'hearts'), card('J', 'diamonds')] });
    expect(discoverLegalOptions(state, 'p1', '5-hearts').some(o => o.kind === 'addToFixed')).toBe(true);
  });

  it('REFUSES it when you hold no key — and the opponent holding one does not help you', () => {
    // There is no partner in two-handed play, so "your side" is just you. An opponent's Jack is
    // emphatically not a path to collecting the house.
    const state = twoHanded({
      hand: [card('5', 'hearts'), card('3', 'diamonds')],
      opponentHand: [card('J', 'diamonds')]
    });
    expect(discoverLegalOptions(state, 'p1', '5-hearts').some(o => o.kind === 'addToFixed')).toBe(false);
  });

  it('ALLOWS a direct match when a second key stays in hand, and refuses it when one does not', () => {
    // The played card reaching the value BY ITSELF — the arm the old rule already covered, checked
    // here in both directions so the revision cannot have quietly changed it.
    const twoJacks = twoHanded({ hand: [card('J', 'diamonds'), card('J', 'clubs')] });
    expect(discoverLegalOptions(twoJacks, 'p1', 'J-diamonds').some(o => o.kind === 'addToFixed')).toBe(true);

    const oneJack = twoHanded({ hand: [card('J', 'diamonds'), card('3', 'diamonds')] });
    expect(discoverLegalOptions(oneJack, 'p1', 'J-diamonds').some(o => o.kind === 'addToFixed')).toBe(false);
  });

  it('leaves ownership untouched when adding to a house your OWN side already owns', () => {
    const state = twoHanded({ hand: [card('5', 'hearts'), card('J', 'diamonds')], houseOwner: 'p1' });
    const add = discoverLegalOptions(state, 'p1', '5-hearts').find(o => o.kind === 'addToFixed')!;
    const after = executeMove(state, 'p1', {
      kind: 'addToFixed',
      handCardId: '5-hearts',
      existingHouseId: add.existingHouseId,
      floorCardIds: add.floorCardIds,
      absorbedLooseCardIds: add.absorbedLooseCardIds
    });

    const house = after.floor.houses.find(h => h.id === 'house-11')!;
    expect(house.ownerSides).toEqual(['p1']);
    expect(house.isCemented).toBe(true);
    expect(house.cards.map(c => c.id)).toContain('5-hearts');
    expect(house.cards.map(c => c.id)).toContain('6-spades');
  });
});

/**
 * knownTeammatesOf is no longer consulted by Add-to-Fixed (the key must be the player's own), but
 * these remain as a guard on the surrounding behaviour: a four-handed state whose teams are not
 * populated must never throw, and must never become MORE permissive.
 */
describe('a four-handed state with no teams recorded is handled safely', () => {
  it('refuses when the player holds no key themselves', () => {
    const state = turn39();
    const teamless: GameState = { ...handing(state, 'you', [card('6', 'clubs'), card('9', 'clubs')]), teams: [] };

    expect(discoverLegalOptions(teamless, 'you', '6-clubs').some(o => o.kind === 'addToFixed')).toBe(false);
  });

  it('still allows it when the player holds the key themselves', () => {
    const state = turn39();
    const teamless: GameState = { ...handing(state, 'you', [card('6', 'clubs'), card('K', 'clubs')]), teams: [] };

    expect(discoverLegalOptions(teamless, 'you', '6-clubs').some(o => o.kind === 'addToFixed')).toBe(true);
  });

  it('never throws on a four-handed state with no teams recorded', () => {
    const state = turn39();
    const teamless: GameState = { ...handing(state, 'you', [card('6', 'clubs'), card('9', 'clubs')]), teams: [] };

    for (const c of teamless.players.find(p => p.id === 'you')!.hand) {
      expect(() => discoverLegalOptions(teamless, 'you', c.id)).not.toThrow();
    }
  });
});
