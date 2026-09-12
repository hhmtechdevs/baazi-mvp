import { describe, expect, it } from 'vitest';
import { looseGap, scatterFor } from './scatter';

describe('loose cards keep the place they landed in', () => {
  it('gives the same card the same offset every time it is asked', () => {
    const first = scatterFor('7-hearts');
    const second = scatterFor('7-hearts');
    expect(second).toEqual(first);
  });

  it('gives different cards visibly different offsets', () => {
    const a = scatterFor('7-hearts');
    const b = scatterFor('7-spades');
    expect(a).not.toEqual(b);
  });

  it('stays within a restrained range, so cards lean rather than tumble', () => {
    const ids = ['A-spades', '10-diamonds', 'K-clubs', '2-hearts', '9-spades', 'J-diamonds', '4-clubs'];
    for (const id of ids) {
      const { dx, dy, rotate } = scatterFor(id);
      expect(Math.abs(dx)).toBeLessThanOrEqual(7);
      expect(Math.abs(dy)).toBeLessThanOrEqual(11);
      expect(Math.abs(rotate)).toBeLessThanOrEqual(8);
    }
  });

  it('spreads a whole deck of ids over both directions, not all one way', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `card-${i}`);
    const rotations = ids.map(id => scatterFor(id).rotate);
    expect(rotations.some(r => r > 1)).toBe(true);
    expect(rotations.some(r => r < -1)).toBe(true);
  });
});

describe('fewer loose cards claim more floor', () => {
  it('spaces two or three cards well apart — wider than a card, so they claim real floor', () => {
    expect(looseGap(3)).toBeGreaterThan(52);
  });

  it('tightens as the floor fills up, but never lets cards overlap', () => {
    const gaps = [2, 4, 6, 9].map(looseGap);
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i]).toBeLessThan(gaps[i - 1]);
    }
    // Even a floor nobody has cleared for a while keeps daylight between its cards.
    expect(looseGap(20)).toBeGreaterThan(0);
    expect(looseGap(20)).toBeLessThanOrEqual(looseGap(9));
  });

  it('needs no gap for a single card', () => {
    expect(looseGap(1)).toBe(0);
    expect(looseGap(0)).toBe(0);
  });
});
