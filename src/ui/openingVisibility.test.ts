import { describe, expect, it } from 'vitest';
import { startRound, submitBid, submitOpeningAction } from '../engine/roundOrchestrator';
import { asSeenByCaller, VISIBLE_PRE_OPENING_CARD_COUNT } from '../engine/moveAdapter';
import { botChooseBid, botChooseOpeningAction } from '../botStrategy';
import { safeBidValues } from './useBaaziGame';

/**
 * Before the opening play, eight cards exist as far as the table is concerned: the four on the
 * floor and the caller's four. Product Owner, 2026-09-19.
 *
 * A person was already held to that — their bid values come from safeBidValues and their options
 * are discovered against the visible four — while a computer seat called and opened from its whole
 * hand. Two-handed, that was twelve cards against four, and it showed: across 150 seeded rounds a
 * computer called a value 27 times that would have left a person in that seat with no legal
 * opening move at all, then played one anyway off cards nobody had turned over.
 */

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

function rounds(mode: '2player' | '4player', count: number, each: (round: number) => void): void {
  const realRandom = Math.random;
  Math.random = seededRandom(20260919);
  try {
    for (let n = 0; n < count; n++) each(n);
  } finally {
    Math.random = realRandom;
  }
}

function dealt(mode: '2player' | '4player', n: number) {
  const ids = mode === '2player' ? ['a', 'b'] : ['a', 'b', 'c', 'd'];
  const game = startRound({
    gameId: `ov-${mode}-${n}`,
    mode,
    players: ids.map(id => ({ id, name: id })),
    dealerId: 'a',
    gameLengthConfig: { type: 'fixedRounds', rounds: 1 }
  });
  return { game, caller: game.state.bidderId! };
}

describe('the caller calls and opens from the four cards they have looked at', () => {
  for (const mode of ['2player', '4player'] as const) {
    it(`${mode}: a computer seat never calls a value a person in that seat could not have called`, () => {
      let checked = 0;
      rounds(mode, 60, n => {
        const { game, caller } = dealt(mode, n);
        const safe = safeBidValues(game, caller);
        const called = botChooseBid(asSeenByCaller(game, caller), caller);
        expect(safe).toContain(called); // would have been offered to a person
        checked++;
      });
      expect(checked).toBe(60);
    });

    it(`${mode}: and opens with one of those four cards, never one still face down`, () => {
      rounds(mode, 60, n => {
        const { game, caller } = dealt(mode, n);
        const visible = game.state.players
          .find(p => p.id === caller)!
          .hand.slice(0, VISIBLE_PRE_OPENING_CARD_COUNT)
          .map(c => c.id);

        const bid = botChooseBid(asSeenByCaller(game, caller), caller);
        const afterBid = submitBid(game, caller, bid);
        const action = botChooseOpeningAction(asSeenByCaller(afterBid, caller), caller);

        const played = action.type === 'build' ? action.builderCardId : action.bidCardId;
        expect(visible).toContain(played);
        if (action.type === 'build') {
          // Its floor cards are the floor's own, which everyone can see once the call is made.
          const floor = afterBid.state.floor.loose.map(c => c.id);
          for (const id of action.floorCardIds) expect(floor).toContain(id);
        }

        // And it really is playable: the engine accepts it against the true hand.
        expect(() => submitOpeningAction(afterBid, caller, action)).not.toThrow();
      });
    });
  }

  it('shows a two-handed caller four of their twelve, and a four-handed caller all four', () => {
    rounds('2player', 1, n => {
      const { game, caller } = dealt('2player', n);
      expect(game.state.players.find(p => p.id === caller)!.hand).toHaveLength(12);
      expect(asSeenByCaller(game, caller).state.players.find(p => p.id === caller)!.hand).toHaveLength(4);
    });
    rounds('4player', 1, n => {
      const { game, caller } = dealt('4player', n);
      expect(game.state.players.find(p => p.id === caller)!.hand).toHaveLength(4);
      expect(asSeenByCaller(game, caller).state.players.find(p => p.id === caller)!.hand).toHaveLength(4);
    });
  });
});
