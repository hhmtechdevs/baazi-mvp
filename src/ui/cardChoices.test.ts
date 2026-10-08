import { describe, expect, it } from 'vitest';
import { choicesForCard, planForCard, verbFor } from './cardChoices';
import { discoverLegalOptions } from '../engine/legalMoves';
import { createDeck } from '../engine/deck';
import type { Card, GameState, House, Player } from '../types';

/**
 * Every option in these tests comes from the real engine. Hand-built options would test that the
 * translator translates whatever it's handed — but the point is that it translates what the
 * referee actually decides, so that is what it's fed.
 */

function card(rank: Card['rank'], suit: Card['suit']): Card {
  return { id: `${rank}-${suit}`, rank, suit };
}

function player(id: string, hand: Card[]): Player {
  return { id, name: id, teamId: null, hand, reserve: [], captured: [] };
}

function position(hand: Card[], floorLoose: Card[] = [], floorHouses: House[] = []): GameState {
  const used = new Set([...hand, ...floorLoose, ...floorHouses.flatMap(h => h.cards)].map(c => c.id));
  return {
    gameId: 'g',
    mode: '2player',
    roundNumber: 1,
    players: [player('p1', hand), player('p2', []), player('elsewhere', createDeck().filter(c => !used.has(c.id)))],
    teams: [],
    floor: { loose: floorLoose, houses: floorHouses },
    deck: [],
    phase: 'playing',
    currentPlayerIndex: 0,
    turnNumber: 5,
    bidValue: null,
    bidderId: null,
    sweepRecords: [],
    scores: {},
    roundScores: {},
    history: []
  };
}

function plan(state: GameState, cardId: string) {
  return planForCard(discoverLegalOptions(state, 'p1', cardId), state);
}

describe('one legal action is simply played', () => {
  it('a card whose only move is to go down is still ASKED — giving a card away is never automatic', () => {
    // Deliberately not played on the tap. A throw is the one move a player regrets, and it is also
    // the commonest single option there is, so an instant throw reads as the table deciding for
    // you — particularly when the build or break you were reaching for was quietly unavailable.
    const four = card('4', 'spades');
    const state = position([four]); // empty floor: nothing to capture or build with
    const result = plan(state, four.id);
    expect(result.kind).toBe('choose');
    expect(result.kind === 'choose' && result.choices.map(c => c.verb)).toEqual(['PLAY CARD']);
  });

  it('a card with exactly one capture is played on the tap', () => {
    const four = card('4', 'spades');
    const state = position([four], [card('4', 'clubs')]);
    const result = plan(state, four.id);
    expect(result.kind).toBe('direct');
    expect(result.kind === 'direct' && result.choice.verb).toBe('COLLECT');
  });

  it('a card with no legal move is unavailable, and a tap does nothing', () => {
    expect(planForCard([], position([card('4', 'spades')])).kind).toBe('unavailable');
    expect(planForCard(undefined, position([card('4', 'spades')])).kind).toBe('unavailable');
  });
});

describe('several legal actions are all offered, and only those', () => {
  it('a card that can COLLECT or BUILD HOUSE offers exactly those two kinds', () => {
    // 3 takes the loose 3, or builds 3 + 8 = 11 (J kept as the key). Capture being available makes
    // playing it down illegal, so PLAY CARD must not appear.
    const three = card('3', 'hearts');
    const state = position([three, card('J', 'spades')], [card('3', 'clubs'), card('8', 'diamonds')]);
    const result = plan(state, three.id);
    expect(result.kind).toBe('choose');
    const verbs = new Set(result.kind === 'choose' ? result.choices.map(c => c.verb) : []);
    expect(verbs).toEqual(new Set(['COLLECT', 'BUILD HOUSE']));
  });

  it('a card that can BUILD HOUSE or be played down offers exactly those two kinds', () => {
    // 2 builds onto the loose 9 (9 + 2 = 11, J kept); nothing on the floor is worth 2.
    const two = card('2', 'hearts');
    const state = position([two, card('J', 'spades')], [card('9', 'clubs')]);
    const result = plan(state, two.id);
    expect(result.kind).toBe('choose');
    const verbs = new Set(result.kind === 'choose' ? result.choices.map(c => c.verb) : []);
    expect(verbs).toEqual(new Set(['BUILD HOUSE', 'PLAY CARD']));
  });

  it('lists captures, then houses, then playing it down — the same order every time', () => {
    const three = card('3', 'hearts');
    const state = position([three, card('J', 'spades')], [card('3', 'clubs'), card('8', 'diamonds')]);
    const verbs = choicesForCard(discoverLegalOptions(state, 'p1', three.id), state).map(c => c.verb);
    const order = ['COLLECT', 'CEMENT', 'ADD TO HOUSE', 'BUILD HOUSE', 'PLAY CARD'];
    expect(verbs).toEqual([...verbs].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    expect(verbs[0]).toBe('COLLECT');
  });

  it('offers exactly as many choices as the engine found legal — never more, never fewer', () => {
    const three = card('3', 'hearts');
    const state = position([three, card('J', 'spades')], [card('3', 'clubs'), card('8', 'diamonds')]);
    const options = discoverLegalOptions(state, 'p1', three.id);
    expect(choicesForCard(options, state)).toHaveLength(options.length);
  });
});

describe('several ways to capture are each offered', () => {
  it('a J facing 2, 3, 5, 6 can take 2 + 3 + 6 or 5 + 6 — both shown, as separate choices', () => {
    // The two groups share the 6, so they are genuinely different captures, not one combined take.
    const j = card('J', 'hearts');
    const state = position([j], [card('2', 'clubs'), card('3', 'diamonds'), card('5', 'spades'), card('6', 'hearts')]);
    const result = plan(state, j.id);
    expect(result.kind).toBe('choose');
    const captures = result.kind === 'choose' ? result.choices.filter(c => c.verb === 'COLLECT') : [];
    expect(captures.length).toBeGreaterThanOrEqual(2);
    // Distinct, readable, and none repeated in a different order.
    const details = captures.map(c => c.detail);
    expect(new Set(details).size).toBe(details.length);
  });

  it('never shows the same cards twice in a different order (2 + A and A + 2 are one choice)', () => {
    const three = card('3', 'hearts');
    const state = position([three], [card('2', 'clubs'), card('A', 'diamonds'), card('3', 'spades')]);
    const choices = choicesForCard(discoverLegalOptions(state, 'p1', three.id), state);
    const asSets = choices.map(c => c.detail.split(/\s*\+\s*/).map(s => s.trim()).sort().join('+'));
    expect(new Set(asSets).size).toBe(asSets.length);
  });
});

describe('a house is only ever built on purpose', () => {
  it('a lone 9 with nothing to build with offers no house — only playing it down, and that is asked', () => {
    const nine = card('9', 'hearts');
    const state = position([nine, card('9', 'clubs')]); // twin kept, empty floor
    const result = plan(state, nine.id);
    expect(result.kind).toBe('choose');
    expect(result.kind === 'choose' && result.choices.map(c => c.verb)).toEqual(['PLAY CARD']);
  });

  it('building on a loose 9 is offered as an explicit BUILD HOUSE choice that shows the sum', () => {
    const two = card('2', 'hearts');
    const state = position([two, card('J', 'spades')], [card('9', 'clubs')]);
    const build = choicesForCard(discoverLegalOptions(state, 'p1', two.id), state).find(c => c.verb === 'BUILD HOUSE');
    expect(build).toBeDefined();
    expect(build!.detail).toMatch(/2/);
    expect(build!.detail).toMatch(/9/);
    expect(build!.detail).toMatch(/11/);
  });
});

describe('plain words at the table', () => {
  it('never shows "Throw" to a player', () => {
    const cases: [Card, Card[]][] = [
      [card('4', 'spades'), []],
      [card('3', 'hearts'), [card('3', 'clubs'), card('8', 'diamonds')]],
      [card('2', 'hearts'), [card('9', 'clubs')]]
    ];
    for (const [played, floor] of cases) {
      const state = position([played, card('J', 'spades')], floor);
      for (const choice of choicesForCard(discoverLegalOptions(state, 'p1', played.id), state)) {
        expect(`${choice.verb} ${choice.detail}`).not.toMatch(/throw/i);
      }
    }
  });

  // Product Owner, 2026-09-19, after a live game: landing a card on a house that is already there
  // is CEMENT, not BUILD HOUSE. Both used to read BUILD HOUSE, which put "COLLECT [13]" beside
  // "BUILD HOUSE K♣ = [13]" — and made cementing read like the lone-King house the rules forbid.
  it('separates cementing, adding to a pukka house, and making or raising one', () => {
    const base = { handCardId: 'x', resultingValue: 11, absorbedLooseCardIds: [] as string[] };
    // Both now turn on whose house it is: free on your own side's, and on anyone else's you must
    // hold the matching card yourself — which also buys you into it.
    expect(verbFor({ kind: 'cement', ...base, floorCardIds: [], existingHouseId: 'h', keySatisfiedBy: 'self', resultingOwnerSides: [] })).toBe('CEMENT');
    expect(verbFor({ kind: 'addToFixed', ...base, floorCardIds: [], existingHouseId: 'h', resultingOwnerSides: ['p1'] })).toBe('ADD TO HOUSE');

    expect(verbFor({ kind: 'build', ...base, floorCardIds: [], resultingOwnerSides: ['p1'] })).toBe('BUILD HOUSE');
    expect(verbFor({ kind: 'break', ...base, existingHouseId: 'h', resultingOwnerSides: ['p1'] })).toBe('BUILD HOUSE');
    expect(verbFor({ kind: 'mergeFix', ...base, existingHouseId: 'h', targetHouseId: 't', resultingOwnerSides: ['p1'] })).toBe('BUILD HOUSE');
  });
});

/**
 * The two things about a move that a player cannot work out by looking: that it clears the floor,
 * and that it leaves the floor for the next player to clear. A sweep is fifty points — the biggest
 * swing in the game — and a round of real play was lost to handing one over unknowingly.
 */
describe('sweeps, marked on the choice itself', () => {
  it('flags a capture that clears the floor', () => {
    const seven = card('7', 'hearts');
    const state = position([seven, card('J', 'spades')], [card('7', 'clubs')]);
    const choices = choicesForCard(discoverLegalOptions(state, 'p1', seven.id), state);
    const collect = choices.find(c => c.verb === 'COLLECT')!;
    expect(collect.sweeps).toBe(true);
    expect(collect.opensSweep).toBeFalsy();
  });

  it('flags a capture that leaves exactly one thing behind for the next player', () => {
    const seven = card('7', 'hearts');
    // Takes the 7, leaves a lone 3 — which anyone holding a 3 then sweeps.
    const state = position([seven, card('J', 'spades')], [card('7', 'clubs'), card('3', 'diamonds')]);
    const collect = choicesForCard(discoverLegalOptions(state, 'p1', seven.id), state).find(c => c.verb === 'COLLECT')!;
    expect(collect.sweeps).toBeFalsy();
    expect(collect.opensSweep).toBe(true);
  });

  it('does not flag a capture that leaves plenty on the floor', () => {
    const seven = card('7', 'hearts');
    const state = position([seven, card('J', 'spades')], [card('7', 'clubs'), card('3', 'diamonds'), card('9', 'hearts')]);
    const collect = choicesForCard(discoverLegalOptions(state, 'p1', seven.id), state).find(c => c.verb === 'COLLECT')!;
    expect(collect.sweeps).toBeFalsy();
    expect(collect.opensSweep).toBeFalsy();
  });

  it('counts the house a build leaves behind, so building is never read as opening a sweep', () => {
    const two = card('2', 'hearts');
    const state = position([two, card('J', 'spades')], [card('9', 'clubs')]);
    const build = choicesForCard(discoverLegalOptions(state, 'p1', two.id), state).find(c => c.verb === 'BUILD HOUSE')!;
    expect(build.opensSweep).toBe(true); // the new house is the only thing on that floor
    const busier = position([two, card('J', 'spades')], [card('9', 'clubs'), card('4', 'spades')]);
    const safer = choicesForCard(discoverLegalOptions(busier, 'p1', two.id), busier).find(c => c.verb === 'BUILD HOUSE')!;
    expect(safer.opensSweep).toBeFalsy(); // house plus the 4 still on the floor
  });
});

describe('a card is never given away on a single tap', () => {
  it('a lone capture still plays straight away — taking cards is not a move anyone regrets', () => {
    const four = card('4', 'spades');
    const state = position([four], [card('4', 'clubs')]);
    const result = plan(state, four.id);
    expect(result.kind).toBe('direct');
    expect(result.kind === 'direct' && result.choice.verb).toBe('COLLECT');
  });

  it('a lone throw asks, and the choice it offers is exactly the engine\'s own throw option', () => {
    const four = card('4', 'spades');
    const state = position([four]);
    const result = plan(state, four.id);
    if (result.kind !== 'choose') throw new Error('expected a confirmation');
    expect(result.choices).toHaveLength(1);
    expect(result.choices[0].option.kind).toBe('throw');
    expect(result.choices[0].option.handCardId).toBe(four.id);
  });
});
