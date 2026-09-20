import { describe, expect, it } from 'vitest';
import { discoverLegalOptions } from './legalMoves';
import type { LegalOption } from './legalMoves';
import { executeMove } from './moveExecution';
import { completeRound, isRoundComplete, startRound, submitBid, submitMove, submitOpeningAction } from './roundOrchestrator';
import { chooseBid, chooseMove, chooseOpeningAction } from '../botStrategy';
import { createDeck } from './deck';
import type { Card, GameState, House, Player, Team } from '../types';

/**
 * HOUSE KEY PRESERVATION (frozen by the Product Owner, 2026-09-19).
 *
 * Every side that owns a house must keep at least one card of that house's capture value in hand
 * until the house is captured or broken, and that last key may only be used to capture it. A side
 * is the player in 2-player mode and the team in 4-player mode; a jointly owned house binds both
 * sides, each with its own key.
 *
 * Why it exists: a seeded 240-round diagnostic found 27 houses left on the floor at round end.
 * Every one was legally built and its capture was always offered, but the owning side spent its
 * last key on a house at a different value, and nothing could ever capture the house after that.
 */

function card(rank: Card['rank'], suit: Card['suit']): Card {
  return { id: `${rank}-${suit}`, rank, suit };
}

function player(id: string, hand: Card[], reserve: Card[] = []): Player {
  return { id, name: id, teamId: null, hand, reserve, captured: [] };
}

function house(id: string, value: number, cards: Card[], ownerSides: string[], isCemented = false): House {
  return { id, ownerSides, cards, captureValue: value, isCemented };
}

const TEAMS: Team[] = [
  { id: 'team-0', name: 'Team 0', playerIds: ['p1', 'p3'] },
  { id: 'team-1', name: 'Team 1', playerIds: ['p2', 'p4'] }
];

/** A mid-round position. Every card not placed is parked in the deck, so the 52-card invariant
 * holds and execution runs its checks exactly as in a real game. */
function position(opts: { players: Player[]; loose?: Card[]; houses?: House[]; current?: number }): GameState {
  const loose = opts.loose ?? [];
  const houses = opts.houses ?? [];
  const used = new Set(
    [...opts.players.flatMap(p => [...p.hand, ...p.reserve]), ...loose, ...houses.flatMap(h => h.cards)].map(c => c.id)
  );
  const fourPlayer = opts.players.length === 4;
  return {
    gameId: 'g',
    mode: fourPlayer ? '4player' : '2player',
    roundNumber: 1,
    players: opts.players,
    teams: fourPlayer ? TEAMS : [],
    floor: { loose, houses },
    deck: createDeck().filter(c => !used.has(c.id)),
    phase: 'playing',
    currentPlayerIndex: opts.current ?? 0,
    turnNumber: 6,
    bidValue: null,
    bidderId: null,
    sweepRecords: [],
    scores: {},
    roundScores: {},
    history: []
  };
}

const options = (state: GameState, pid: string, c: Card): LegalOption[] => discoverLegalOptions(state, pid, c.id);
const kinds = (state: GameState, pid: string, c: Card) => options(state, pid, c).map(o => o.kind);
const houseActions = (state: GameState, pid: string, c: Card) => options(state, pid, c).filter(o => o.kind !== 'capture' && o.kind !== 'throw');
const capturesHouse = (state: GameState, pid: string, c: Card, houseId: string) =>
  options(state, pid, c).some(o => o.kind === 'capture' && o.targets.some(t => t.type === 'house' && t.houseId === houseId));

// Cards reused across scenarios. The protected house is always a 10 (6 + 4) unless stated.
const ten = card('10', 'hearts');
const tenB = card('10', 'spades');
const tenC = card('10', 'clubs');
const queen = card('Q', 'spades');
const two = card('2', 'clubs');
const tenHouse = (ownerSides: string[], isCemented = false) =>
  isCemented
    ? house('house-10', 10, [card('6', 'clubs'), card('4', 'diamonds'), card('10', 'diamonds')], ownerSides, true)
    : house('house-10', 10, [card('6', 'clubs'), card('4', 'diamonds')], ownerSides);

describe('A. own house + last key', () => {
  const state = position({
    players: [player('p1', [ten, queen]), player('p2', [card('3', 'hearts')])],
    loose: [two],
    houses: [tenHouse(['p1'])]
  });

  it('a different build using the last 10 is not legal (10 + 2 = 12, even though a Q is kept for it)', () => {
    expect(houseActions(state, 'p1', ten)).toEqual([]);
  });

  it('capturing the 10-house is legal, and throwing is not', () => {
    expect(capturesHouse(state, 'p1', ten, 'house-10')).toBe(true);
    expect(kinds(state, 'p1', ten)).not.toContain('throw');
  });

  it('control: the same build is legal when the 10-house is not on the floor', () => {
    const noHouse = position({ players: [player('p1', [ten, queen]), player('p2', [card('3', 'hearts')])], loose: [two] });
    expect(kinds(noHouse, 'p1', ten)).toContain('build');
  });

  it('the referee refuses the build if it is sent directly, and leaves the position untouched', () => {
    const before = JSON.stringify(state);
    expect(() => executeMove(state, 'p1', { kind: 'build', handCardId: ten.id, floorCardIds: [two.id], absorbedLooseCardIds: [] })).toThrow(
      /not currently legal/
    );
    expect(JSON.stringify(state)).toBe(before);
  });

  it('only cards in hand count — a 10 still waiting in the 2-player reserve does not free the last one', () => {
    const withReserve = position({
      players: [player('p1', [ten, queen], [tenB]), player('p2', [card('3', 'hearts')])],
      loose: [two],
      houses: [tenHouse(['p1'])]
    });
    expect(houseActions(withReserve, 'p1', ten)).toEqual([]);
  });
});

describe('B. own house + several keys', () => {
  it('one 10 may be used elsewhere, but the final remaining 10 is preserved', () => {
    const start = position({
      players: [player('p1', [ten, tenB, queen]), player('p2', [card('3', 'hearts'), card('5', 'hearts')])],
      loose: [two, card('2', 'diamonds')],
      houses: [tenHouse(['p1'])]
    });
    // With two 10s, either one may go into a 12.
    expect(kinds(start, 'p1', ten)).toContain('build');
    expect(kinds(start, 'p1', tenB)).toContain('build');

    // Spend the first: 10 + 2 = 12.
    const after = executeMove(start, 'p1', { kind: 'build', handCardId: ten.id, floorCardIds: [two.id], absorbedLooseCardIds: [] });
    expect(after.floor.houses.find(h => h.captureValue === 12)).toBeDefined();

    // The last 10 would otherwise cement onto the new 12 (10 + the other 2, Q still kept) — now it may only capture.
    expect(houseActions(after, 'p1', tenB)).toEqual([]);
    expect(capturesHouse(after, 'p1', tenB, 'house-10')).toBe(true);
  });
});

describe('C. partner key (4-player)', () => {
  const players = (partnerHand: Card[]) => [
    player('p1', [ten, queen]),
    player('p2', [card('3', 'hearts')]),
    player('p3', partnerHand),
    player('p4', [card('5', 'hearts')])
  ];

  for (const [label, ownerSides] of [
    ["the player's own house", ['p1']],
    ["the partner's house", ['p3']]
  ] as const) {
    it(`${label}: the player may spend their 10 while the partner still holds one`, () => {
      const state = position({ players: players([tenB]), loose: [two], houses: [tenHouse([...ownerSides])] });
      expect(kinds(state, 'p1', ten)).toContain('build');
    });

    it(`${label}: once the partner has no 10, the player's 10 is the team's last key`, () => {
      const state = position({ players: players([card('7', 'hearts')]), loose: [two], houses: [tenHouse([...ownerSides])] });
      expect(houseActions(state, 'p1', ten)).toEqual([]);
      expect(capturesHouse(state, 'p1', ten, 'house-10')).toBe(true);
    });
  }

  it('a same-side cemented house (recorded as the team id) is protected the same way', () => {
    const covered = position({ players: players([tenB]), loose: [two], houses: [tenHouse(['team-0'], true)] });
    expect(kinds(covered, 'p1', ten)).toContain('build');
    const lastKey = position({ players: players([card('7', 'hearts')]), loose: [two], houses: [tenHouse(['team-0'], true)] });
    expect(houseActions(lastKey, 'p1', ten)).toEqual([]);
  });

  it("an opponent's house never restricts the player's 10", () => {
    const state = position({ players: players([card('7', 'hearts')]), loose: [two], houses: [tenHouse(['p2'])] });
    expect(kinds(state, 'p1', ten)).toContain('build');
  });
});

describe('D. jointly owned house', () => {
  it("2-player: each side needs its own key — the opponent's 10 does not cover mine", () => {
    const state = position({
      players: [player('p1', [ten, queen]), player('p2', [tenB, card('Q', 'hearts')])],
      loose: [two],
      houses: [tenHouse(['p1', 'p2'], true)]
    });
    expect(houseActions(state, 'p1', ten)).toEqual([]);
    expect(houseActions(state, 'p2', tenB)).toEqual([]); // and the same holds the other way round
    expect(capturesHouse(state, 'p1', ten, 'house-10')).toBe(true);
    expect(capturesHouse(state, 'p2', tenB, 'house-10')).toBe(true);
  });

  it('2-player: a second 10 of my own frees one of mine', () => {
    const state = position({
      players: [player('p1', [ten, tenC, queen]), player('p2', [tenB])],
      loose: [two],
      houses: [tenHouse(['p1', 'p2'], true)]
    });
    expect(kinds(state, 'p1', ten)).toContain('build');
  });

  it("4-player: the other team's 10 does not count, my partner's does", () => {
    const players = (partnerHand: Card[]) => [
      player('p1', [ten, queen]),
      player('p2', [tenB]),
      player('p3', partnerHand),
      player('p4', [card('5', 'hearts')])
    ];
    const opponentsOnly = position({ players: players([card('7', 'hearts')]), loose: [two], houses: [tenHouse(['team-0', 'team-1'], true)] });
    expect(houseActions(opponentsOnly, 'p1', ten)).toEqual([]);

    const partnerToo = position({ players: players([tenC]), loose: [two], houses: [tenHouse(['team-0', 'team-1'], true)] });
    expect(kinds(partnerToo, 'p1', ten)).toContain('build');
  });
});

describe('E. the key is free again once the house is gone', () => {
  it('after an opponent captures the house', () => {
    const state = position({
      players: [player('p1', [ten, queen]), player('p2', [tenB, card('3', 'hearts')])],
      loose: [two],
      houses: [tenHouse(['p1'])],
      current: 1
    });
    expect(houseActions(state, 'p1', ten)).toEqual([]);

    const captured = executeMove(state, 'p2', { kind: 'capture', handCardId: tenB.id, targets: [{ type: 'house', houseId: 'house-10' }] });
    expect(captured.floor.houses).toHaveLength(0);
    expect(kinds(captured, 'p1', ten)).toContain('build');
  });

  it('after an opponent breaks the house into a different value', () => {
    const state = position({
      players: [player('p1', [ten, queen]), player('p2', [card('2', 'diamonds'), card('Q', 'hearts')])],
      loose: [two],
      houses: [tenHouse(['p1'])],
      current: 1
    });
    expect(houseActions(state, 'p1', ten)).toEqual([]);

    const broken = executeMove(state, 'p2', { kind: 'break', handCardId: '2-diamonds', existingHouseId: 'house-10', absorbedLooseCardIds: [] });
    expect(broken.floor.houses.map(h => h.captureValue)).toEqual([12]);
    // 10 + 2 now lands on the opponent's 12: a cement, legal again (p1 still keeps a Q).
    expect(kinds(broken, 'p1', ten)).toContain('cement');
  });
});

describe('F. every house action is closed to the last key', () => {
  const opponentTwelve = (isCemented: boolean) =>
    isCemented
      ? house('house-12', 12, [card('8', 'clubs'), card('4', 'clubs'), card('Q', 'diamonds')], ['p2'], true)
      : house('house-12', 12, [card('8', 'clubs'), card('4', 'clubs')], ['p2']);

  const cases: { kind: LegalOption['kind']; houses: House[]; move: Parameters<typeof executeMove>[2] }[] = [
    {
      kind: 'build',
      houses: [],
      move: { kind: 'build', handCardId: ten.id, floorCardIds: [two.id], absorbedLooseCardIds: [] }
    },
    {
      kind: 'cement',
      houses: [opponentTwelve(false)],
      move: { kind: 'cement', handCardId: ten.id, existingHouseId: 'house-12', floorCardIds: [two.id], absorbedLooseCardIds: [] }
    },
    {
      kind: 'addToFixed',
      houses: [opponentTwelve(true)],
      move: { kind: 'addToFixed', handCardId: ten.id, existingHouseId: 'house-12', floorCardIds: [two.id], absorbedLooseCardIds: [] }
    }
  ];

  for (const { kind, houses, move } of cases) {
    it(`${kind}: legal with a spare 10, closed to the last one — in discovery and at the referee`, () => {
      const hands = (mine: Card[]) => [player('p1', mine), player('p2', [card('3', 'hearts')])];
      const spare = position({ players: hands([ten, tenB, queen]), loose: [two], houses: [tenHouse(['p1']), ...houses] });
      expect(kinds(spare, 'p1', ten)).toContain(kind); // would otherwise be legal
      expect(() => executeMove(spare, 'p1', move)).not.toThrow();

      const last = position({ players: hands([ten, queen]), loose: [two], houses: [tenHouse(['p1']), ...houses] });
      expect(kinds(last, 'p1', ten)).not.toContain(kind);
      expect(() => executeMove(last, 'p1', move)).toThrow(/not currently legal/);
      expect(capturesHouse(last, 'p1', ten, 'house-10')).toBe(true);
    });
  }

  it('break and merge-fix can never spend a key at all: a key is 9–13 and so is every house, and 9 + 9 is already past 13', () => {
    const nine = card('9', 'hearts');
    const state = position({
      players: [player('p1', [nine, card('9', 'spades'), card('K', 'spades')]), player('p2', [card('3', 'hearts')])],
      houses: [house('house-9', 9, [card('5', 'clubs'), card('4', 'clubs')], ['p1']), house('house-opp', 9, [card('6', 'diamonds'), card('3', 'diamonds')], ['p2'])]
    });
    const raising = options(state, 'p1', nine).filter(o => o.kind === 'break' || o.kind === 'mergeFix');
    expect(raising).toEqual([]);
  });

  it('capture choices for a protected key are exactly what they would be without the obligation', () => {
    // A 10 over the house plus two ways to make 10 from loose cards (7+3, 6+4).
    const loose = [card('7', 'diamonds'), card('3', 'spades'), card('6', 'hearts'), card('4', 'spades')];
    const captures = (hand: Card[]) =>
      options(position({ players: [player('p1', hand), player('p2', [card('5', 'hearts')])], loose, houses: [tenHouse(['p1'])] }), 'p1', ten).filter(
        o => o.kind === 'capture'
      );
    expect(captures([ten, queen])).toEqual(captures([ten, tenB, queen]));
    expect(captures([ten, queen]).length).toBeGreaterThan(0);
  });
});

describe('across real games', () => {
  function seededRandom(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // The diagnostic seed. Before this rule, these same 60 deals left houses on the floor in 5 rounds.
  it('no round ends with a house still on the floor', () => {
    const realRandom = Math.random;
    Math.random = seededRandom(20260918);
    const leftovers: string[] = [];
    try {
      for (const mode of ['2player', '4player'] as const) {
        const ids = mode === '2player' ? ['a', 'b'] : ['a', 'b', 'c', 'd'];
        for (let n = 0; n < 30; n++) {
          let game = startRound({
            gameId: `hk-${mode}-${n}`,
            mode,
            players: ids.map(id => ({ id, name: id })),
            dealerId: 'a',
            gameLengthConfig: { type: 'fixedRounds', rounds: 1 }
          });
          const bidder = game.state.bidderId!;
          game = submitBid(game, bidder, chooseBid(game, bidder).choice);
          game = submitOpeningAction(game, bidder, chooseOpeningAction(game, bidder).choice);
          for (let guard = 0; !isRoundComplete(game) && guard < 400; guard++) {
            const current = game.state.players[game.state.currentPlayerIndex].id;
            game = submitMove(game, current, chooseMove(game, current).choice);
          }
          expect(isRoundComplete(game)).toBe(true);
          if (game.state.floor.houses.length) leftovers.push(`${mode} #${n}: ${game.state.floor.houses.map(h => h.captureValue).join(', ')}`);
          completeRound(game);
        }
      }
    } finally {
      Math.random = realRandom;
    }
    expect(leftovers).toEqual([]);
  });
});
