import { describe, expect, it } from 'vitest';
import { discoverLegalOptions, discoverLegalOptionsForHand } from './legalMoves';
import { executeMove } from './moveExecution';
import { createDeck } from './deck';
import { toOpeningAction } from './moveAdapter';
import { submitOpeningAction } from './roundOrchestrator';
import type { Card, CaptureTarget, GameState, Player } from '../types';

/**
 * POSITIONS REPORTED FROM LIVE PLAY, 2026-10-06.
 *
 * Two opening moves that looked wrong at the table. Neither turned out to be a missing capture,
 * but both are pinned here, because "I am sure I saw this" is only ever settled by a position that
 * can be re-run — and one of them is the frozen House Key Preservation rule doing its job, which
 * is exactly the behaviour most likely to be "fixed" by mistake later.
 */

const card = (rank: Card['rank'], suit: Card['suit']): Card => ({ id: `${rank}-${suit}`, rank, suit });
const player = (id: string, hand: Card[]): Player => ({ id, name: id, teamId: null, hand, reserve: [], captured: [] });

function position(hand: Card[], loose: Card[], opts: { opening: boolean; bid: number }): GameState {
  const opponent = [card('2', 'hearts')];
  const used = new Set([...hand, ...loose, ...opponent].map(c => c.id));
  const base: GameState = {
    gameId: 'reported', mode: '2player', roundNumber: 1,
    players: [player('p1', hand), player('p2', opponent)],
    teams: [], floor: { loose, houses: [] },
    deck: createDeck().filter(c => !used.has(c.id)),
    phase: 'playing', currentPlayerIndex: 0, turnNumber: 6,
    bidValue: null, bidderId: null, sweepRecords: [], scores: {}, roundScores: {}, history: []
  };
  return opts.opening
    ? { ...base, phase: 'revealing', bidderId: 'p1', bidValue: opts.bid, turnNumber: 0 }
    : base;
}

const taken = (targets: readonly CaptureTarget[]) =>
  targets.map(t => (t.type === 'loose' ? t.cardId : t.houseId)).sort();

/**
 * "I called K. There was a King and an 8 and a 5 on the floor, and two Kings in my hand. The move
 * was 8+5 — it did not combine the K on the floor."
 *
 * The floor King and the 8+5 pair are two separate groups worth 13 that share no card, so the
 * frozen "collect everything compatible" rule must take all three in one capture.
 */
describe('reported: called K, floor holds K 8 5, two Kings in hand', () => {
  const hand = [card('K', 'spades'), card('K', 'clubs'), card('4', 'hearts'), card('3', 'diamonds')];
  const floor = (fourth: Card) => [card('K', 'hearts'), card('8', 'diamonds'), card('5', 'clubs'), fourth];

  it('offers one capture at the opening, taking the floor King AND the 8 and 5 together', () => {
    const state = position(hand, floor(card('3', 'spades')), { opening: true, bid: 13 });
    const captures = discoverLegalOptionsForHand(state, 'p1')['K-spades'].filter(o => o.kind === 'capture');

    expect(captures).toHaveLength(1);
    expect(taken(captures[0].targets)).toEqual(['5-clubs', '8-diamonds', 'K-hearts']);
  });

  it('offers the same capture on an ordinary turn', () => {
    const state = position(hand, floor(card('3', 'spades')), { opening: false, bid: 13 });
    const captures = discoverLegalOptions(state, 'p1', 'K-spades').filter(o => o.kind === 'capture');

    expect(captures).toHaveLength(1);
    expect(taken(captures[0].targets)).toEqual(['5-clubs', '8-diamonds', 'K-hearts']);
  });

  it('actually collects all three when played, leaving only the fourth floor card', () => {
    const state = position(hand, floor(card('3', 'spades')), { opening: false, bid: 13 });
    const capture = discoverLegalOptions(state, 'p1', 'K-spades').find(o => o.kind === 'capture')!;
    const after = executeMove(state, 'p1', { kind: 'capture', handCardId: 'K-spades', targets: capture.targets });

    expect(after.players.find(p => p.id === 'p1')!.captured.map(c => c.id).sort()).toEqual(
      ['5-clubs', '8-diamonds', 'K-hearts', 'K-spades'].sort()
    );
    expect(after.floor.loose.map(c => c.id)).toEqual(['3-spades']);
  });

  it('takes all three whatever the fourth floor card happens to be', () => {
    // The report could not say what the fourth card was, so every candidate is checked rather than
    // one being assumed.
    for (const rank of ['A', '2', '3', '4', '6', '7', '9', '10', 'J', 'Q'] as Card['rank'][]) {
      const fourth = card(rank, 'spades');
      const state = position(hand.filter(c => c.id !== fourth.id), floor(fourth), { opening: true, bid: 13 });
      const captures = (discoverLegalOptionsForHand(state, 'p1')['K-spades'] ?? []).filter(o => o.kind === 'capture');

      expect(captures, `fourth card ${fourth.id}`).toHaveLength(1);
      expect(taken(captures[0].targets), `fourth card ${fourth.id}`).toContain('K-hearts');
    }
  });
});

/**
 * "I had a Jack in hand, 9 + 2 on the floor and a Jack on the floor. It did not allow me to build
 * a Jack with the 9, 2 and Jack."
 *
 * Correct, and not for a reason the table ever explained: building an 11-house means the builder's
 * side must keep an 11 in hand to collect it (House Key Preservation, frozen 2026-09-19), and the
 * only Jack they had was the one going into the house. With a second Jack the build is offered.
 */
describe('reported: one Jack in hand, floor holds 9 2 and a Jack', () => {
  const floor = [card('9', 'hearts'), card('2', 'diamonds'), card('J', 'clubs'), card('7', 'spades')];

  it('withholds the build when the only Jack would go into the house', () => {
    const state = position(
      [card('J', 'spades'), card('4', 'hearts'), card('3', 'diamonds'), card('6', 'clubs')],
      floor,
      { opening: false, bid: 11 }
    );
    const options = discoverLegalOptions(state, 'p1', 'J-spades');

    expect(options.some(o => o.kind === 'build')).toBe(false);
    // The capture is still there — the Jack is not stranded, it simply must take rather than build.
    expect(options.map(o => o.kind)).toEqual(['capture']);
  });

  it('offers exactly that build once a second Jack is held back as the key', () => {
    const state = position(
      [card('J', 'spades'), card('J', 'diamonds'), card('3', 'diamonds'), card('6', 'clubs')],
      floor,
      { opening: false, bid: 11 }
    );
    const builds = discoverLegalOptions(state, 'p1', 'J-spades').filter(o => o.kind === 'build');

    expect(builds).toHaveLength(1);
    expect(builds[0].resultingValue).toBe(11);
    expect([...builds[0].absorbedLooseCardIds].sort()).toEqual(['2-diamonds', '9-hearts', 'J-clubs']);
  });

  it('builds an 11-house holding all four cards, with the second Jack still in hand', () => {
    const state = position(
      [card('J', 'spades'), card('J', 'diamonds'), card('3', 'diamonds'), card('6', 'clubs')],
      floor,
      { opening: false, bid: 11 }
    );
    const build = discoverLegalOptions(state, 'p1', 'J-spades').find(o => o.kind === 'build')!;
    const after = executeMove(state, 'p1', {
      kind: 'build',
      handCardId: 'J-spades',
      floorCardIds: build.floorCardIds,
      absorbedLooseCardIds: build.absorbedLooseCardIds
    });

    expect(after.floor.houses).toHaveLength(1);
    expect(after.floor.houses[0].captureValue).toBe(11);
    expect(after.floor.houses[0].cards.map(c => c.id).sort()).toEqual(
      ['2-diamonds', '9-hearts', 'J-clubs', 'J-spades'].sort()
    );
    expect(after.players.find(p => p.id === 'p1')!.hand.some(c => c.id === 'J-diamonds')).toBe(true);
  });
});

/**
 * "Hand 7 8 J K. I called K. Floor 8 5 6 Q. I added the 7 to the 6 — the 8 and 5 are still loose
 * on the floor. They should have combined."
 *
 * FIXED 2026-10-07. The opening build path hardcoded `absorbedLooseCardIds: []`, so the opening
 * ignored the frozen Combine rule that normal play obeys. These tests were pinned as `it.fails`
 * while the defect stood and are ordinary assertions now that it does not.
 */
describe('reported: called 13, floor 8 5 6 Q, building with the 7', () => {
  const hand = [card('7', 'clubs'), card('8', 'hearts'), card('J', 'spades'), card('K', 'diamonds')];
  const floor = [card('8', 'spades'), card('5', 'clubs'), card('6', 'diamonds'), card('Q', 'hearts')];

  it('on an ordinary turn, sweeps the 8 and 5 into the house alongside the 7 and 6', () => {
    const state = position(hand, floor, { opening: false, bid: 13 });
    const builds = discoverLegalOptions(state, 'p1', '7-clubs').filter(o => o.kind === 'build');

    expect(builds).toHaveLength(1);
    expect(builds[0].floorCardIds).toEqual(['6-diamonds']);
    expect([...builds[0].absorbedLooseCardIds].sort()).toEqual(['5-clubs', '8-spades']);
  });

  it('offers exactly the same build at the opening — the defect, now fixed', () => {
    const state = position(hand, floor, { opening: true, bid: 13 });
    const builds = (discoverLegalOptionsForHand(state, 'p1')['7-clubs'] ?? []).filter(o => o.kind === 'build');

    expect(builds).toHaveLength(1);
    expect(builds[0].floorCardIds).toEqual(['6-diamonds']);
    expect([...builds[0].absorbedLooseCardIds].sort()).toEqual(['5-clubs', '8-spades']);
  });

  it('carries the absorbed cards through to the opening action', () => {
    const state = position(hand, floor, { opening: true, bid: 13 });
    const build = (discoverLegalOptionsForHand(state, 'p1')['7-clubs'] ?? []).find(o => o.kind === 'build')!;
    const action = toOpeningAction(build);

    expect(action.type).toBe('build');
    if (action.type !== 'build') throw new Error('expected a build');
    expect([...(action.absorbedLooseCardIds ?? [])].sort()).toEqual(['5-clubs', '8-spades']);
  });

  it('plays out exactly as specified: a 13-house of 7 6 8 5, with only the Q left loose', () => {
    const state = position(hand, floor, { opening: true, bid: 13 });
    const build = (discoverLegalOptionsForHand(state, 'p1')['7-clubs'] ?? []).find(o => o.kind === 'build')!;
    const game = { state, dealerId: 'p2', gameLengthConfig: { type: 'fixedRounds' as const, rounds: 1 } };

    const after = submitOpeningAction(game, 'p1', toOpeningAction(build)).state;

    expect(after.floor.houses).toHaveLength(1);
    const house = after.floor.houses[0];
    expect(house.captureValue).toBe(13);
    expect(house.cards.map(c => c.id).sort()).toEqual(
      ['5-clubs', '6-diamonds', '7-clubs', '8-spades'].sort()
    );
    expect(after.floor.loose.map(c => c.id)).toEqual(['Q-hearts']);
    // Built from more than one group, so it is a fixed house — the same rule normal play applies.
    expect(house.isCemented).toBe(true);
    // The K stays in hand as the key, untouched by any of this.
    expect(after.players.find(p => p.id === 'p1')!.hand.map(c => c.id).sort()).toEqual(
      ['8-hearts', 'J-spades', 'K-diamonds'].sort()
    );
  });

  it('refuses a build that walks past a group it could have incorporated', () => {
    // "Can be incorporated" means "must be": the old, defective action is now rejected outright
    // rather than quietly leaving the 8 and 5 on the floor.
    const state = position(hand, floor, { opening: true, bid: 13 });
    const game = { state, dealerId: 'p2', gameLengthConfig: { type: 'fixedRounds' as const, rounds: 1 } };

    expect(() =>
      submitOpeningAction(game, 'p1', {
        type: 'build',
        builderCardId: '7-clubs',
        floorCardIds: ['6-diamonds'],
        absorbedLooseCardIds: []
      })
    ).toThrow(/must be incorporated/);
  });

  it('refuses absorbed cards that are not whole groups worth the called value', () => {
    const state = position(hand, floor, { opening: true, bid: 13 });
    const game = { state, dealerId: 'p2', gameLengthConfig: { type: 'fixedRounds' as const, rounds: 1 } };

    expect(() =>
      submitOpeningAction(game, 'p1', {
        type: 'build',
        builderCardId: '7-clubs',
        floorCardIds: ['6-diamonds'],
        absorbedLooseCardIds: ['8-spades', '5-clubs', 'Q-hearts']
      })
    ).toThrow(/do not divide into groups/);
  });

  it('still builds a plain, uncemented house when there is nothing to absorb', () => {
    // The ordinary case must not have been dragged along by the fix: one group, no absorption,
    // not a fixed house.
    const plainFloor = [card('6', 'diamonds'), card('Q', 'hearts'), card('3', 'spades'), card('4', 'hearts')];
    const state = position(hand, plainFloor, { opening: true, bid: 13 });
    const build = (discoverLegalOptionsForHand(state, 'p1')['7-clubs'] ?? []).find(o => o.kind === 'build')!;
    const game = { state, dealerId: 'p2', gameLengthConfig: { type: 'fixedRounds' as const, rounds: 1 } };

    expect(build.absorbedLooseCardIds).toEqual([]);
    const after = submitOpeningAction(game, 'p1', toOpeningAction(build)).state;
    expect(after.floor.houses[0].cards.map(c => c.id).sort()).toEqual(['6-diamonds', '7-clubs'].sort());
    expect(after.floor.houses[0].isCemented).toBe(false);
  });
});

/**
 * CEMENTING AT THE OPENING — how many combinations, not whether anything was absorbed.
 *
 * One combination worth the called value makes an ordinary house. Two or more, incorporated into
 * the same house, make a fixed one. The implementation counts combinations explicitly rather than
 * inferring it from the absorbed list, and these pin each arm of that rule.
 */
describe('one combination or several, at the opening', () => {
  const game = (state: GameState) => ({ state, dealerId: 'p2', gameLengthConfig: { type: 'fixedRounds' as const, rounds: 1 } });
  const openingBuild = (state: GameState, cardId: string) =>
    (discoverLegalOptionsForHand(state, 'p1')[cardId] ?? []).filter(o => o.kind === 'build');

  const hand = [card('7', 'clubs'), card('K', 'diamonds'), card('3', 'hearts'), card('2', 'spades')];

  it('ONE combination — 7 + 6 = 13 and nothing else — builds an ORDINARY house', () => {
    // Nothing else on this floor is worth 13: Q, 9 and 2 make 12, 9, 2, 11, 14, 21 and 23.
    const floor = [card('6', 'diamonds'), card('Q', 'hearts'), card('9', 'spades'), card('2', 'clubs')];
    const state = position(hand, floor, { opening: true, bid: 13 });
    const build = openingBuild(state, '7-clubs')[0];
    expect(build.absorbedLooseCardIds).toEqual([]);

    const house = submitOpeningAction(game(state), 'p1', toOpeningAction(build)).state.floor.houses[0];
    expect(house.isCemented).toBe(false);
    expect(house.cards.map(c => c.id).sort()).toEqual(['6-diamonds', '7-clubs'].sort());
  });

  it('TWO combinations — 7 + 6 = 13 and 8 + 5 = 13 — build a CEMENTED house', () => {
    const floor = [card('6', 'diamonds'), card('8', 'spades'), card('5', 'clubs'), card('Q', 'hearts')];
    const state = position(hand, floor, { opening: true, bid: 13 });
    const build = openingBuild(state, '7-clubs')[0];

    const after = submitOpeningAction(game(state), 'p1', toOpeningAction(build)).state;
    expect(after.floor.houses[0].isCemented).toBe(true);
    expect(after.floor.houses[0].cards).toHaveLength(4);
  });

  it('THREE combinations — 7 + 6, 8 + 5, and a lone King — still CEMENTED, all of it in the house', () => {
    // A group may be a single card: a King is already worth 13 on its own. The "no card stands
    // alone" rule governs the card being PLAYED, not a group being incorporated.
    const floor = [card('6', 'diamonds'), card('8', 'spades'), card('5', 'clubs'), card('K', 'hearts')];
    const state = position(hand, floor, { opening: true, bid: 13 });
    const build = openingBuild(state, '7-clubs')[0];
    expect([...build.absorbedLooseCardIds].sort()).toEqual(['5-clubs', '8-spades', 'K-hearts'].sort());

    const after = submitOpeningAction(game(state), 'p1', toOpeningAction(build)).state;
    expect(after.floor.houses[0].isCemented).toBe(true);
    expect(after.floor.houses[0].cards.map(c => c.id).sort()).toEqual(
      ['5-clubs', '6-diamonds', '7-clubs', '8-spades', 'K-hearts'].sort()
    );
    expect(after.floor.loose).toHaveLength(0);
  });

  it('the same rule at a called 12: 7 + 5 and a lone Queen, both incorporated, cemented', () => {
    // The direction gave this example as "Q + A = 12", which is 13 — a Queen is 12 and an Ace is
    // 1. The case it was reaching for is two independent combinations at the called value, which
    // is what this is: the played 7 takes the 5, and the floor Queen is already worth 12 by itself.
    const twelveHand = [card('7', 'clubs'), card('Q', 'diamonds'), card('3', 'hearts'), card('2', 'spades')];
    const floor = [card('5', 'spades'), card('Q', 'hearts'), card('9', 'clubs'), card('4', 'diamonds')];
    const state = position(twelveHand, floor, { opening: true, bid: 12 });

    const build = openingBuild(state, '7-clubs')[0];
    expect(build.floorCardIds).toEqual(['5-spades']);
    expect(build.absorbedLooseCardIds).toEqual(['Q-hearts']);

    const after = submitOpeningAction(game(state), 'p1', toOpeningAction(build)).state;
    expect(after.floor.houses[0].captureValue).toBe(12);
    expect(after.floor.houses[0].isCemented).toBe(true);
    expect(after.floor.houses[0].cards.map(c => c.id).sort()).toEqual(
      ['5-spades', '7-clubs', 'Q-hearts'].sort()
    );
    expect(after.floor.loose.map(c => c.id).sort()).toEqual(['4-diamonds', '9-clubs'].sort());
  });

  it('cards unrelated to the called value are left exactly where they were', () => {
    const floor = [card('6', 'diamonds'), card('8', 'spades'), card('5', 'clubs'), card('Q', 'hearts')];
    const state = position(hand, floor, { opening: true, bid: 13 });
    const build = openingBuild(state, '7-clubs')[0];

    const after = submitOpeningAction(game(state), 'p1', toOpeningAction(build)).state;
    expect(after.floor.loose.map(c => c.id)).toEqual(['Q-hearts']);
  });

  it('OVERLAPPING combinations stay a choice — the engine offers both, it does not pick', () => {
    // 8 + 5♣ and 8 + 5♦ are both worth 13 but share the 8, so they cannot both be incorporated.
    // Two separate builds are offered and the player decides; whichever is taken, the other five
    // stays loose.
    const floor = [card('6', 'diamonds'), card('8', 'spades'), card('5', 'clubs'), card('5', 'diamonds')];
    const state = position(hand, floor, { opening: true, bid: 13 });
    const builds = openingBuild(state, '7-clubs');

    expect(builds).toHaveLength(2);
    const absorbed = builds.map(b => [...b.absorbedLooseCardIds].sort().join('+')).sort();
    expect(absorbed).toEqual(['5-clubs+8-spades', '5-diamonds+8-spades'].sort());

    for (const build of builds) {
      const after = submitOpeningAction(game(state), 'p1', toOpeningAction(build)).state;
      expect(after.floor.houses[0].isCemented).toBe(true);
      expect(after.floor.loose).toHaveLength(1);
      expect(after.floor.loose[0].rank).toBe('5');
    }
  });
});

/**
 * NOT part of the absorption fix, and deliberately left alone.
 *
 * Normal play allows a build where the played card is laid DOWN and a group already worth the
 * value is swept in alongside it — a J with 5 + 6 beside it becomes a J-house (frozen test 6d).
 * The opening forbids this: it requires the played card to combine with at least one floor card.
 *
 * That divergence is real and is a separate rules decision, recorded in
 * OPENING_BUILD_ABSORPTION.md. This test pins the CURRENT opening behaviour so that implementing
 * absorption could not change it by accident, and so that changing it later has to be deliberate.
 */
describe('lay-alongside at the opening — unchanged, pending a rules decision', () => {
  const hand = [card('J', 'spades'), card('J', 'diamonds'), card('3', 'clubs'), card('4', 'hearts')];
  const floor = [card('5', 'hearts'), card('6', 'clubs'), card('2', 'spades'), card('9', 'diamonds')];

  it('normal play offers it: the J lies down and the 5 + 6 joins it', () => {
    const state = position(hand, floor, { opening: false, bid: 11 });
    const builds = discoverLegalOptions(state, 'p1', 'J-spades').filter(o => o.kind === 'build');

    expect(builds.length).toBeGreaterThan(0);
    expect(builds.some(b => b.floorCardIds.length === 0 && b.absorbedLooseCardIds.length > 0)).toBe(true);
  });

  it('the opening still does NOT offer it, exactly as before the absorption fix', () => {
    const state = position(hand, floor, { opening: true, bid: 11 });
    const builds = (discoverLegalOptionsForHand(state, 'p1')['J-spades'] ?? []).filter(o => o.kind === 'build');

    expect(builds.every(b => b.floorCardIds.length > 0)).toBe(true);
  });

  it('and the opening action still refuses one if asked directly', () => {
    const state = position(hand, floor, { opening: true, bid: 11 });
    const game = { state, dealerId: 'p2', gameLengthConfig: { type: 'fixedRounds' as const, rounds: 1 } };

    expect(() =>
      submitOpeningAction(game, 'p1', {
        type: 'build',
        builderCardId: 'J-spades',
        floorCardIds: [],
        absorbedLooseCardIds: ['5-hearts', '6-clubs']
      })
    ).toThrow(/on its own is a loose card/);
  });
});
