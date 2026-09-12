import { describe, expect, it } from 'vitest';
import { submitOpeningAction } from './openingAction';
import { assertCardInvariant, collectAllCards } from './deal';
import { createDeck } from './deck';
import type { Card, GameState, House, Player } from '../types';

function card(rank: Card['rank'], suit: Card['suit']): Card {
  return { id: `${rank}-${suit}`, rank, suit };
}

function makePlayer(id: string, hand: Card[]): Player {
  return { id, name: id, teamId: null, hand, reserve: [], captured: [] };
}

/**
 * Builds a full, invariant-satisfying GameState in the 'revealing' phase: the bidder's hand and
 * named floor cards are exactly the ones under test, and every other physical card in the
 * canonical deck is parked on a third "elsewhere" player so the 52-card invariant is meaningful.
 */
function makeState(opts: { bidderHand: Card[]; floorLoose?: Card[]; floorHouses?: House[]; bidValue?: number }): GameState {
  const floorLoose = opts.floorLoose ?? [];
  const floorHouses = opts.floorHouses ?? [];
  const used = new Set([...opts.bidderHand, ...floorLoose, ...floorHouses.flatMap(h => h.cards)].map(c => c.id));
  const rest = createDeck().filter(c => !used.has(c.id));
  return {
    gameId: 'g',
    mode: '4player',
    roundNumber: 1,
    players: [makePlayer('bidder', opts.bidderHand), makePlayer('dealer', []), makePlayer('elsewhere', rest)],
    teams: [],
    floor: { loose: floorLoose, houses: floorHouses },
    deck: [],
    phase: 'revealing',
    currentPlayerIndex: 0,
    turnNumber: 0,
    bidValue: opts.bidValue ?? 11,
    bidderId: 'bidder',
    sweepRecords: [],
    scores: {},
    roundScores: {},
    history: []
  };
}

describe('submitOpeningAction — build', () => {
  it('creates a house at the bid value and retains the matching capture card (spec example)', () => {
    const two = card('2', 'clubs');
    const j = card('J', 'hearts');
    const six = card('6', 'spades');
    const three = card('3', 'diamonds');
    const state = makeState({ bidderHand: [two, j], floorLoose: [six, three], bidValue: 11 });

    const next = submitOpeningAction(state, 'bidder', { type: 'build', builderCardId: two.id, floorCardIds: [six.id, three.id] });
    const house = next.floor.houses[0];
    const bidder = next.players.find(p => p.id === 'bidder')!;

    expect(house.captureValue).toBe(11);
    expect(house.ownerSides).toEqual(['bidder']);
    expect(house.isCemented).toBe(false);
    expect(new Set(house.cards.map(c => c.id))).toEqual(new Set([two.id, six.id, three.id]));
    expect(bidder.hand.some(c => c.id === j.id)).toBe(true); // retained
    expect(bidder.hand.some(c => c.id === two.id)).toBe(false); // played
    expect(next.floor.loose).toHaveLength(0);
    expect(next.phase).toBe('opening');
    assertCardInvariant(next);
    expect(collectAllCards(next)).toHaveLength(52);
  });

  it('rejects a build whose total does not equal the bid value', () => {
    const state = makeState({ bidderHand: [card('6', 'spades'), card('J', 'hearts')], floorLoose: [card('2', 'clubs')], bidValue: 11 });
    expect(() =>
      submitOpeningAction(state, 'bidder', { type: 'build', builderCardId: '6-spades', floorCardIds: ['2-clubs'] })
    ).toThrow(/totals 8/);
  });

  it('rejects a build that would consume the only matching capture card', () => {
    const j = card('J', 'hearts'); // rank 11, same as the bid
    const state = makeState({
      bidderHand: [j],
      floorLoose: [card('2', 'clubs'), card('3', 'diamonds'), card('6', 'spades')],
      bidValue: 11
    });
    expect(() => submitOpeningAction(state, 'bidder', { type: 'build', builderCardId: j.id, floorCardIds: [] })).toThrow(/retained/);
  });

  it('rejects using a card that belongs to an existing house as though it were loose', () => {
    const j = card('J', 'hearts');
    const houseCards = [card('6', 'clubs'), card('5', 'clubs')];
    const house: House = { id: 'house-xyz', ownerSides: ['dealer'], cards: houseCards, captureValue: 11, isCemented: false };
    const state = makeState({ bidderHand: [j], floorHouses: [house], bidValue: 11 });
    expect(() =>
      submitOpeningAction(state, 'bidder', { type: 'build', builderCardId: j.id, floorCardIds: [houseCards[0].id] })
    ).toThrow(/part of an existing house/);
  });

  it('rejects a nonexistent floor card', () => {
    const state = makeState({ bidderHand: [card('6', 'spades'), card('J', 'hearts')], bidValue: 11 });
    expect(() =>
      submitOpeningAction(state, 'bidder', { type: 'build', builderCardId: '6-spades', floorCardIds: ['ghost-card'] })
    ).toThrow(/not a loose card/);
  });
});

describe('submitOpeningAction — throw', () => {
  it('moves the bid-value card to the loose floor and creates nothing', () => {
    const j = card('J', 'hearts');
    const state = makeState({ bidderHand: [j, card('4', 'spades')], bidValue: 11 });
    const next = submitOpeningAction(state, 'bidder', { type: 'throw', bidCardId: j.id });

    expect(next.floor.loose.some(c => c.id === j.id)).toBe(true);
    expect(next.floor.houses).toHaveLength(0);
    expect(next.players.find(p => p.id === 'bidder')!.hand.some(c => c.id === j.id)).toBe(false);
    expect(next.players.find(p => p.id === 'bidder')!.captured).toHaveLength(0);
    expect(next.phase).toBe('opening');
    assertCardInvariant(next);
  });

  it('rejects a card that does not match the bid value', () => {
    const state = makeState({ bidderHand: [card('4', 'spades')], bidValue: 11 });
    expect(() => submitOpeningAction(state, 'bidder', { type: 'throw', bidCardId: '4-spades' })).toThrow(/does not match the bid/);
  });

  it('rejects a card not actually in the hand', () => {
    const state = makeState({ bidderHand: [card('J', 'hearts')], bidValue: 11 });
    expect(() => submitOpeningAction(state, 'bidder', { type: 'throw', bidCardId: 'not-a-real-card' })).toThrow(/not in your hand/);
  });
});

describe('submitOpeningAction — capture', () => {
  it('captures a legal set of loose cards totaling the bid value', () => {
    const j = card('J', 'hearts');
    const six = card('6', 'spades');
    const five = card('5', 'diamonds');
    const state = makeState({ bidderHand: [j], floorLoose: [six, five], bidValue: 11 });

    const next = submitOpeningAction(state, 'bidder', {
      type: 'capture',
      bidCardId: j.id,
      targets: [{ type: 'loose', cardId: six.id }, { type: 'loose', cardId: five.id }]
    });

    const bidder = next.players.find(p => p.id === 'bidder')!;
    expect([j.id, six.id, five.id].every(id => bidder.captured.some(c => c.id === id))).toBe(true);
    expect(next.floor.loose).toHaveLength(0);
    assertCardInvariant(next);
  });

  it('captures TWO independent loose cards that each individually equal the bid value, together in one action (regression: this must not require their combined total to equal the bid)', () => {
    // Bug found via bot stress-testing: a played 9 with two separate loose 9s on the floor is a
    // legal capture of BOTH (each is its own complete one-card match to the bid value) — not an
    // illegal one because 9+9=18 != 9. The old validation incorrectly summed every target
    // together and rejected this; the fix checks that the targets partition into groups each
    // individually summing to the bid value, matching Ingredient 4's own already-correct
    // "non-overlapping combinations are combined together" discovery (see legalMoves.test.ts's
    // "6b").
    const nine = card('9', 'hearts');
    const looseNineA = card('9', 'diamonds');
    const looseNineB = card('9', 'spades');
    const state = makeState({ bidderHand: [nine], floorLoose: [looseNineA, looseNineB, card('2', 'diamonds')], bidValue: 9 });

    const next = submitOpeningAction(state, 'bidder', {
      type: 'capture',
      bidCardId: nine.id,
      targets: [{ type: 'loose', cardId: looseNineA.id }, { type: 'loose', cardId: looseNineB.id }]
    });

    const bidder = next.players.find(p => p.id === 'bidder')!;
    expect([nine.id, looseNineA.id, looseNineB.id].every(id => bidder.captured.some(c => c.id === id))).toBe(true);
    expect(next.floor.loose.map(c => c.id)).toEqual(['2-diamonds']); // untouched, unrelated card remains
    assertCardInvariant(next);
  });

  it('rejects loose targets that cannot be grouped into combinations each summing to the bid value', () => {
    const j = card('J', 'hearts'); // bid value 11
    const state = makeState({ bidderHand: [j], floorLoose: [card('6', 'spades'), card('2', 'diamonds')], bidValue: 11 });
    // 6+2=8, not 11, and neither is a standalone match either — genuinely illegal.
    expect(() =>
      submitOpeningAction(state, 'bidder', {
        type: 'capture',
        bidCardId: j.id,
        targets: [{ type: 'loose', cardId: '6-spades' }, { type: 'loose', cardId: '2-diamonds' }]
      })
    ).toThrow(/could not be grouped/);
  });

  it('captures a house whose captureValue matches the bid', () => {
    const j = card('J', 'hearts');
    const houseCards = [card('6', 'clubs'), card('5', 'clubs')];
    const house: House = { id: 'house-abc', ownerSides: ['dealer'], cards: houseCards, captureValue: 11, isCemented: false };
    const state = makeState({ bidderHand: [j], floorHouses: [house], bidValue: 11 });

    const next = submitOpeningAction(state, 'bidder', {
      type: 'capture',
      bidCardId: j.id,
      targets: [{ type: 'house', houseId: house.id }]
    });

    expect(next.floor.houses).toHaveLength(0);
    const bidder = next.players.find(p => p.id === 'bidder')!;
    expect([j.id, ...houseCards.map(c => c.id)].every(id => bidder.captured.some(c => c.id === id))).toBe(true);
    assertCardInvariant(next);
  });

  it('rejects a nonexistent capture target', () => {
    const j = card('J', 'hearts');
    const state = makeState({ bidderHand: [j], bidValue: 11 });
    expect(() =>
      submitOpeningAction(state, 'bidder', { type: 'capture', bidCardId: j.id, targets: [{ type: 'loose', cardId: 'ghost' }] })
    ).toThrow(/not a loose card/);
  });

  it('rejects referencing a house card as though it were loose', () => {
    const j = card('J', 'hearts');
    const houseCards = [card('6', 'clubs'), card('5', 'clubs')];
    const house: House = { id: 'house-xyz', ownerSides: ['dealer'], cards: houseCards, captureValue: 11, isCemented: false };
    const state = makeState({ bidderHand: [j], floorHouses: [house], bidValue: 11 });
    expect(() =>
      submitOpeningAction(state, 'bidder', {
        type: 'capture',
        bidCardId: j.id,
        targets: [{ type: 'loose', cardId: houseCards[0].id }]
      })
    ).toThrow(/part of a house/);
  });

  it('rejects treating a lone King as a House', () => {
    const j = card('J', 'hearts');
    const king = card('K', 'spades'); // fixed value 13, but a LOOSE card — never a House
    const state = makeState({ bidderHand: [j], floorLoose: [king], bidValue: 11 });
    expect(() =>
      submitOpeningAction(state, 'bidder', { type: 'capture', bidCardId: j.id, targets: [{ type: 'house', houseId: king.id }] })
    ).toThrow(/No house exists/);
  });
});

describe('submitOpeningAction — shared guard rails', () => {
  it('rejects an opening action from anyone other than the caller', () => {
    const state = makeState({ bidderHand: [card('J', 'hearts')], bidValue: 11 });
    expect(() => submitOpeningAction(state, 'dealer', { type: 'throw', bidCardId: 'J-hearts' })).toThrow(/Only the caller/);
  });

  it('rejects an opening action outside the revealing phase', () => {
    const state: GameState = { ...makeState({ bidderHand: [card('J', 'hearts')], bidValue: 11 }), phase: 'bidding' };
    expect(() => submitOpeningAction(state, 'bidder', { type: 'throw', bidCardId: 'J-hearts' })).toThrow(/Expected phase/);
  });
});
