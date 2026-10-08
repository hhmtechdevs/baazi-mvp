import { afterEach, describe, expect, it, vi } from 'vitest';
import { newHouseId } from './ids';
import { discoverLegalOptions } from './legalMoves';
import { executeMove } from './moveExecution';
import { createDeck } from './deck';
import type { Card, GameState, Player } from '../types';

/**
 * REPORTED FROM AN IPHONE, 2026-10-06: every move that made a house blanked the screen.
 *
 * `crypto.randomUUID` is defined only in a SECURE CONTEXT — https, or localhost. A phone opening
 * the dev server over the local network is neither, so the function was simply absent, the engine
 * threw mid-move, and React unmounted the whole table. These tests run the house-making paths with
 * randomUUID taken away, which is the exact condition on that phone.
 */

const card = (rank: Card['rank'], suit: Card['suit']): Card => ({ id: `${rank}-${suit}`, rank, suit });
const player = (id: string, hand: Card[]): Player => ({ id, name: id, teamId: null, hand, reserve: [], captured: [] });

/** Removes randomUUID the way an insecure context does: the property is not there at all. */
function withoutRandomUUID(run: () => void): void {
  const original = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
  try {
    run();
  } finally {
    if (original) Object.defineProperty(globalThis.crypto, 'randomUUID', original);
  }
}

afterEach(() => vi.restoreAllMocks());

describe('house ids survive a browser without crypto.randomUUID', () => {
  it('still produces an id at all', () => {
    withoutRandomUUID(() => {
      expect(newHouseId()).toMatch(/^house-/);
    });
  });

  it('produces ids that are all different, including within the same millisecond', () => {
    withoutRandomUUID(() => {
      const ids = new Set(Array.from({ length: 2000 }, () => newHouseId()));
      expect(ids.size).toBe(2000);
    });
  });

  it('uses randomUUID when it IS available, so nothing changes in a normal browser', () => {
    const spy = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('1-2-3-4-5');
    expect(newHouseId()).toBe('house-1-2-3-4-5');
    expect(spy).toHaveBeenCalled();
  });
});

describe('building a house on a phone over the local network', () => {
  const hand = [card('7', 'clubs'), card('K', 'diamonds'), card('3', 'hearts'), card('2', 'spades')];
  const loose = [card('6', 'diamonds'), card('Q', 'hearts')];

  function position(): GameState {
    const opponent = [card('2', 'hearts')];
    const used = new Set([...hand, ...loose, ...opponent].map(c => c.id));
    return {
      gameId: 'g', mode: '2player', roundNumber: 1,
      players: [player('p1', hand), player('p2', opponent)],
      teams: [], floor: { loose, houses: [] },
      deck: createDeck().filter(c => !used.has(c.id)),
      phase: 'playing', currentPlayerIndex: 0, turnNumber: 6,
      bidValue: null, bidderId: null, sweepRecords: [], scores: {}, roundScores: {}, history: []
    };
  }

  it('does not throw — this is the blank screen, reproduced', () => {
    withoutRandomUUID(() => {
      const state = position();
      const build = discoverLegalOptions(state, 'p1', '7-clubs').find(o => o.kind === 'build')!;
      expect(build).toBeDefined();

      const after = executeMove(state, 'p1', {
        kind: 'build',
        handCardId: '7-clubs',
        floorCardIds: build.floorCardIds,
        absorbedLooseCardIds: build.absorbedLooseCardIds
      });

      expect(after.floor.houses).toHaveLength(1);
      expect(after.floor.houses[0].id).toMatch(/^house-/);
      expect(after.floor.houses[0].captureValue).toBe(13);
    });
  });
});
