import { describe, expect, it } from 'vitest';
import { describeLegalOption, labelLegalOptions } from './describeOption';
import type { LegalOption } from '../engine/legalMoves';
import type { Card, GameState, House, Player } from '../types';

function card(rank: Card['rank'], suit: Card['suit']): Card {
  return { id: `${rank}-${suit}`, rank, suit };
}

function makeState(opts: { hand?: Card[]; floorLoose?: Card[]; floorHouses?: House[] }): GameState {
  const player: Player = { id: 'p1', name: 'p1', teamId: null, hand: opts.hand ?? [], reserve: [], captured: [] };
  return {
    gameId: 'g',
    mode: '2player',
    roundNumber: 1,
    players: [player, { id: 'p2', name: 'p2', teamId: null, hand: [], reserve: [], captured: [] }],
    teams: [],
    floor: { loose: opts.floorLoose ?? [], houses: opts.floorHouses ?? [] },
    deck: [],
    phase: 'playing',
    currentPlayerIndex: 0,
    turnNumber: 3,
    bidValue: null,
    bidderId: null,
    sweepRecords: [],
    scores: {},
    roundScores: {},
    history: []
  };
}

const house = (id: string, captureValue: number, cards: Card[], isCemented = false): House => ({
  id,
  ownerSides: ['p1'],
  cards,
  captureValue,
  isCemented
});

describe('move labels read as equations, not prose', () => {
  it('a build shows played card + floor cards = the new house value', () => {
    const state = makeState({ hand: [card('5', 'hearts')], floorLoose: [card('6', 'clubs')] });
    const option: LegalOption = {
      kind: 'build',
      handCardId: '5-hearts',
      floorCardIds: ['6-clubs'],
      resultingValue: 11,
      absorbedLooseCardIds: [],
      resultingOwnerSides: ['p1']
    };
    expect(describeLegalOption(option, state)).toBe('(5 + 6) = 11');
  });

  it('adds up every card that actually combines to reach the value', () => {
    const state = makeState({
      hand: [card('3', 'hearts')],
      floorLoose: [card('3', 'clubs'), card('5', 'spades')]
    });
    const option: LegalOption = {
      kind: 'build',
      handCardId: '3-hearts',
      floorCardIds: ['3-clubs', '5-spades'],
      resultingValue: 11,
      absorbedLooseCardIds: [],
      resultingOwnerSides: ['p1']
    };
    expect(describeLegalOption(option, state)).toBe('(3 + 3 + 5) = 11');
  });

  it('aces and court cards keep their letter and suit; the total stays a number', () => {
    const state = makeState({ hand: [card('A', 'spades')], floorLoose: [card('10', 'hearts')] });
    const option: LegalOption = {
      kind: 'build',
      handCardId: 'A-spades',
      floorCardIds: ['10-hearts'],
      resultingValue: 11,
      absorbedLooseCardIds: [],
      resultingOwnerSides: ['p1']
    };
    expect(describeLegalOption(option, state)).toBe('(A♠ + 10) = 11');
  });

  it('a build needing no floor cards still names the card being played', () => {
    const state = makeState({ hand: [card('Q', 'spades')] });
    const option: LegalOption = {
      kind: 'build',
      handCardId: 'Q-spades',
      floorCardIds: [],
      resultingValue: 12,
      absorbedLooseCardIds: [],
      resultingOwnerSides: ['p1']
    };
    expect(describeLegalOption(option, state)).toBe('Q♠ = 12');
  });

  it('shows swept-in groups apart from the sum, since they are not addends of it', () => {
    // Playing the Jack lands on the existing 11-house on its own; the loose 4+7 is a separate
    // group that also makes 11 and comes along automatically. Printing it as "(J + 4 + 7) = 11"
    // would be arithmetic that doesn't add up.
    const existing = house('h1', 11, [card('2', 'spades'), card('9', 'clubs')], true);
    const state = makeState({
      hand: [card('J', 'clubs')],
      floorLoose: [card('4', 'clubs'), card('7', 'clubs')],
      floorHouses: [existing]
    });
    const option: LegalOption = {
      kind: 'addToFixed',
      handCardId: 'J-clubs',
      existingHouseId: 'h1',
      floorCardIds: [],
      resultingValue: 11,
      absorbedLooseCardIds: ['4-clubs', '7-clubs']
    };
    expect(describeLegalOption(option, state)).toBe('J♣ = [11] (+4 +7)');
  });

  it('landing on an existing house names that house in brackets on the result side', () => {
    const existing = house('h1', 11, [card('9', 'clubs'), card('2', 'diamonds')]);
    const state = makeState({ hand: [card('5', 'hearts')], floorLoose: [card('6', 'clubs')], floorHouses: [existing] });
    const cement: LegalOption = {
      kind: 'cement',
      handCardId: '5-hearts',
      existingHouseId: 'h1',
      floorCardIds: ['6-clubs'],
      resultingValue: 11,
      absorbedLooseCardIds: [],
      keySatisfiedBy: 'self',
      resultingOwnerSides: ['p1']
    };
    expect(describeLegalOption(cement, state)).toBe('(5 + 6) = [11]');
  });

  it('raising an existing house puts that house first, in brackets', () => {
    const existing = house('h1', 9, [card('9', 'clubs')]);
    const state = makeState({ hand: [card('2', 'hearts')], floorHouses: [existing] });
    const option: LegalOption = {
      kind: 'break',
      handCardId: '2-hearts',
      existingHouseId: 'h1',
      resultingValue: 11,
      absorbedLooseCardIds: [],
      resultingOwnerSides: ['p1']
    };
    expect(describeLegalOption(option, state)).toBe('([9] + 2) = 11');
  });

  it('captures keep a verb, since the same cards could equally be built into a house', () => {
    const state = makeState({ hand: [card('J', 'clubs')], floorLoose: [card('5', 'hearts'), card('6', 'spades')] });
    const option: LegalOption = {
      kind: 'capture',
      handCardId: 'J-clubs',
      targets: [
        { type: 'loose', cardId: '5-hearts' },
        { type: 'loose', cardId: '6-spades' }
      ],
      value: 11,
      isSeep: false
    };
    expect(describeLegalOption(option, state)).toBe('Take 5 + 6');
  });

  it('capturing a house names it in brackets, and a Seep is flagged', () => {
    const existing = house('h1', 11, [card('9', 'clubs'), card('2', 'diamonds')]);
    const state = makeState({ hand: [card('J', 'clubs')], floorHouses: [existing] });
    const option: LegalOption = {
      kind: 'capture',
      handCardId: 'J-clubs',
      targets: [{ type: 'house', houseId: 'h1' }],
      value: 11,
      isSeep: true
    };
    expect(describeLegalOption(option, state)).toBe('Take [11] · Seep');
  });
});

describe('suits come back only where two options would otherwise read the same', () => {
  it('leaves labels bare when they are already distinct', () => {
    const state = makeState({ hand: [card('J', 'clubs')], floorLoose: [card('5', 'hearts'), card('6', 'spades')] });
    const options: LegalOption[] = [
      { kind: 'capture', handCardId: 'J-clubs', targets: [{ type: 'loose', cardId: '5-hearts' }], value: 5, isSeep: false },
      { kind: 'throw', handCardId: 'J-clubs' }
    ];
    expect(labelLegalOptions(options, state)).toEqual(['Take 5', 'Throw']);
  });

  it('court cards are already distinct, since their suit is always shown', () => {
    const state = makeState({ hand: [card('Q', 'clubs'), card('Q', 'hearts')] });
    const build = (id: string): LegalOption => ({
      kind: 'build',
      handCardId: id,
      floorCardIds: [],
      resultingValue: 12,
      absorbedLooseCardIds: [],
      resultingOwnerSides: ['p1']
    });
    expect(labelLegalOptions([build('Q-clubs'), build('Q-hearts')], state)).toEqual(['Q♣ = 12', 'Q♥ = 12']);
  });

  it('still falls back to suits for two same-valued NUMBER cards, which carry no suit by default', () => {
    const state = makeState({ hand: [card('10', 'diamonds'), card('10', 'spades')] });
    const build = (id: string): LegalOption => ({
      kind: 'build',
      handCardId: id,
      floorCardIds: [],
      resultingValue: 10,
      absorbedLooseCardIds: [],
      resultingOwnerSides: ['p1']
    });
    expect(labelLegalOptions([build('10-diamonds'), build('10-spades')], state)).toEqual(['10♦ = 10', '10♠ = 10']);
  });

  it('adds suits when two genuinely different moves use same-valued cards', () => {
    // Both 2s are on the floor; taking 2♦+4 and taking 2♥+4 are different moves that would
    // otherwise both render as "Take 2 + 4".
    const state = makeState({
      hand: [card('6', 'clubs')],
      floorLoose: [card('2', 'diamonds'), card('2', 'hearts'), card('4', 'spades')]
    });
    const options: LegalOption[] = [
      {
        kind: 'capture',
        handCardId: '6-clubs',
        targets: [
          { type: 'loose', cardId: '2-diamonds' },
          { type: 'loose', cardId: '4-spades' }
        ],
        value: 6,
        isSeep: false
      },
      {
        kind: 'capture',
        handCardId: '6-clubs',
        targets: [
          { type: 'loose', cardId: '2-hearts' },
          { type: 'loose', cardId: '4-spades' }
        ],
        value: 6,
        isSeep: false
      }
    ];
    expect(labelLegalOptions(options, state)).toEqual(['Take 2♦ + 4♠', 'Take 2♥ + 4♠']);
  });
});
