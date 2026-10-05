import { describe, expect, it } from 'vitest';
import { describeMove, floorIsOneCaptureFromEmpty, floorItems, housePoints, loosePoints } from './moveNarrative';
import { executeMove } from '../engine/moveExecution';
import { createDeck } from '../engine/deck';
import type { Card, GameState, House, Player } from '../types';

/**
 * Every receipt here is produced by running a real move through the engine and diffing the two
 * states, never by hand-writing a "next" state — so if execution ever moves cards differently, the
 * sentence changes with it rather than quietly lying.
 */

const card = (rank: Card['rank'], suit: Card['suit']): Card => ({ id: `${rank}-${suit}`, rank, suit });
const player = (id: string, hand: Card[]): Player => ({ id, name: id, teamId: null, hand, reserve: [], captured: [] });

function position(opts: { mine: Card[]; theirs?: Card[]; loose?: Card[]; houses?: House[] }): GameState {
  const loose = opts.loose ?? [];
  const houses = opts.houses ?? [];
  const theirs = opts.theirs ?? [card('2', 'hearts')];
  const used = new Set([...opts.mine, ...theirs, ...loose, ...houses.flatMap(h => h.cards)].map(c => c.id));
  return {
    gameId: 'g',
    mode: '2player',
    roundNumber: 1,
    players: [player('p1', opts.mine), player('p2', theirs)],
    teams: [],
    floor: { loose, houses },
    deck: createDeck().filter(c => !used.has(c.id)),
    phase: 'playing',
    currentPlayerIndex: 0,
    turnNumber: 4,
    bidValue: null,
    bidderId: null,
    sweepRecords: [],
    scores: {},
    roundScores: {},
    history: []
  };
}

describe('what just happened, read from the change itself', () => {
  it('names the card, what it collected, and what that was worth', () => {
    const ten = card('10', 'spades');
    const before = position({ mine: [ten, card('3', 'hearts')], loose: [card('6', 'clubs'), card('4', 'spades')] });
    const after = executeMove(before, 'p1', {
      kind: 'capture',
      handCardId: ten.id,
      targets: [{ type: 'loose', cardId: '6-clubs' }, { type: 'loose', cardId: '4-spades' }]
    });

    const receipt = describeMove(before, after)!;
    expect(receipt.actorId).toBe('p1');
    expect(receipt.kind).toBe('capture');
    expect(receipt.text).toBe('10♠ collected 6♣ + 4♠');
    expect(receipt.points).toBe(14); // 10♠ is ten, 4♠ is four, 6♣ nothing
  });

  it('calls a sweep a sweep, and says what it paid', () => {
    const seven = card('7', 'hearts');
    const before = position({ mine: [seven, card('3', 'hearts')], loose: [card('7', 'clubs')] });
    const after = executeMove(before, 'p1', {
      kind: 'capture',
      handCardId: seven.id,
      targets: [{ type: 'loose', cardId: '7-clubs' }]
    });

    const receipt = describeMove(before, after)!;
    expect(receipt.kind).toBe('capture');
    expect(receipt.seepPoints).toBe(50); // the floor was left empty
  });

  it('reads a new house as a build, with the cards that made it', () => {
    const seven = card('7', 'diamonds');
    const before = position({ mine: [seven, card('J', 'spades')], loose: [card('4', 'clubs')] });
    const after = executeMove(before, 'p1', {
      kind: 'build',
      handCardId: seven.id,
      floorCardIds: ['4-clubs'],
      absorbedLooseCardIds: []
    });

    const receipt = describeMove(before, after)!;
    expect(receipt.kind).toBe('build');
    expect(receipt.text).toBe('Built a 11-house · 7♦ + 4♣');
  });

  it('tells cementing apart from adding to a house that is already pukka', () => {
    const ordinary: House = { id: 'h11', ownerSides: ['p1'], cards: [card('6', 'clubs'), card('5', 'clubs')], captureValue: 11, isCemented: false };
    const cementing = position({ mine: [card('J', 'hearts'), card('J', 'spades')], houses: [ordinary] });
    const cemented = executeMove(cementing, 'p1', {
      kind: 'cement',
      handCardId: 'J-hearts',
      existingHouseId: 'h11',
      floorCardIds: [],
      absorbedLooseCardIds: []
    });
    expect(describeMove(cementing, cemented)!.text).toBe('Cemented the 11-house · J♥');
    expect(describeMove(cementing, cemented)!.kind).toBe('cement');

    const pukka: House = { ...ordinary, id: 'h11p', cards: [...ordinary.cards, card('J', 'diamonds')], isCemented: true };
    const adding = position({ mine: [card('7', 'hearts'), card('J', 'spades')], loose: [card('4', 'hearts')], houses: [pukka] });
    const added = executeMove(adding, 'p1', {
      kind: 'addToFixed',
      handCardId: '7-hearts',
      existingHouseId: 'h11p',
      floorCardIds: ['4-hearts'],
      absorbedLooseCardIds: []
    });
    const receipt = describeMove(adding, added)!;
    expect(receipt.kind).toBe('addToHouse');
    expect(receipt.text).toBe('Added to the 11-house · 7♥ + 4♥');
  });

  it('says plainly when a card simply went down', () => {
    const before = position({ mine: [card('3', 'hearts'), card('9', 'clubs')] });
    const after = executeMove(before, 'p1', { kind: 'throw', handCardId: '3-hearts' });
    expect(describeMove(before, after)!.text).toBe('3♥ played to the floor');
  });

  it('announces the reserve coming into play, which belongs to nobody’s turn', () => {
    const before = position({ mine: [], theirs: [] });
    before.players[0].reserve = [card('2', 'clubs')];
    before.players[1].reserve = [card('3', 'clubs')];
    const after: GameState = {
      ...before,
      players: before.players.map(p => ({ ...p, hand: p.reserve, reserve: [] }))
    };
    const receipt = describeMove(before, after)!;
    expect(receipt.kind).toBe('reserve');
    expect(receipt.text).toMatch(/second half/i);
    expect(receipt.actorId).toBeNull();
  });

  it('says nothing rather than inventing something when no card was played', () => {
    const state = position({ mine: [card('3', 'hearts')] });
    expect(describeMove(state, state)).toBeNull();
  });
});

describe('what the floor is worth, and whether it is about to be given away', () => {
  it('counts loose cards and houses as the things a capture has to clear', () => {
    const house: House = { id: 'h', ownerSides: ['p1'], cards: [card('6', 'clubs'), card('5', 'clubs')], captureValue: 11, isCemented: false };
    const state = position({ mine: [], loose: [card('4', 'spades')], houses: [house] });
    expect(floorItems(state)).toBe(2);
    expect(floorIsOneCaptureFromEmpty(state)).toBe(false);
  });

  it('counts a lone house as sweepable, exactly like a lone card', () => {
    const house: House = { id: 'h', ownerSides: ['p1'], cards: [card('6', 'clubs'), card('5', 'clubs')], captureValue: 11, isCemented: false };
    expect(floorIsOneCaptureFromEmpty(position({ mine: [], houses: [house] }))).toBe(true);
    expect(floorIsOneCaptureFromEmpty(position({ mine: [], loose: [card('4', 'spades')] }))).toBe(true);
    expect(floorIsOneCaptureFromEmpty(position({ mine: [] }))).toBe(false); // already empty
  });

  it('adds up the points lying loose, which is the number worth showing', () => {
    const state = position({ mine: [], loose: [card('5', 'spades'), card('6', 'spades'), card('9', 'hearts')] });
    expect(loosePoints(state)).toBe(11);
  });
});

describe('what a house is worth to whoever takes it', () => {
  it('adds up the points inside, not the cards', () => {
    const rich: House = {
      id: 'h11',
      ownerSides: ['p1'],
      cards: [card('J', 'spades'), card('A', 'hearts'), card('6', 'clubs'), card('5', 'clubs')],
      captureValue: 11,
      isCemented: false
    };
    expect(housePoints(rich)).toBe(12); // J♠ eleven, A♥ one, the clubs nothing

    const shell: House = { ...rich, cards: [card('6', 'clubs'), card('5', 'clubs')] };
    expect(housePoints(shell)).toBe(0); // same value, nothing in it
  });
});
