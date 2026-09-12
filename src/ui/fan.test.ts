import { describe, expect, it } from 'vitest';
import { fanAngles, fanRadius, fanScale } from './fan';

/** Matches House.tsx — kept in sync so these tests describe the real fan, not a hypothetical one. */
const DEGREES_PER_CARD = 15;
const MAX_SPREAD = 150;
const COMFORTABLE_CARDS = 6;
const MIN_SCALE = 0.62;

const houseFan = (count: number) => fanAngles(count, DEGREES_PER_CARD, MAX_SPREAD);

describe('house fan geometry', () => {
  it('gives every card its own angle — a fan never hides or drops cards, however many there are', () => {
    for (const count of [2, 5, 10, 15, 20]) {
      const angles = houseFan(count);
      expect(angles).toHaveLength(count);
      expect(new Set(angles).size).toBe(count);
    }
  });

  it('stays a semi-circle at most — adding cards tightens the gaps instead of widening the arc forever', () => {
    for (const count of [2, 5, 10, 15, 20, 40]) {
      const angles = houseFan(count);
      const spread = angles[angles.length - 1] - angles[0];
      expect(spread).toBeLessThanOrEqual(MAX_SPREAD + 0.001); // never a full circle
    }
  });

  it('opens gently for a small house and widely for a big one', () => {
    const two = houseFan(2);
    const five = houseFan(5);
    const ten = houseFan(10);
    const spreadOf = (a: number[]) => a[a.length - 1] - a[0];
    expect(spreadOf(two)).toBeCloseTo(15); // barely opens
    expect(spreadOf(five)).toBeCloseTo(60);
    expect(spreadOf(ten)).toBeGreaterThan(spreadOf(five));
  });

  it('is symmetric about the house it came from, so the fan stays centred on its own tile', () => {
    for (const count of [2, 5, 10, 15]) {
      const angles = houseFan(count);
      expect(angles[0]).toBeCloseTo(-angles[angles.length - 1]);
    }
  });

  it('leaves cards full size until a house gets crowded, then shrinks them — never below the floor', () => {
    expect(fanScale(2, COMFORTABLE_CARDS, MIN_SCALE)).toBe(1);
    expect(fanScale(6, COMFORTABLE_CARDS, MIN_SCALE)).toBe(1);
    expect(fanScale(10, COMFORTABLE_CARDS, MIN_SCALE)).toBeLessThan(1);
    expect(fanScale(15, COMFORTABLE_CARDS, MIN_SCALE)).toBeLessThan(fanScale(10, COMFORTABLE_CARDS, MIN_SCALE));
    expect(fanScale(40, COMFORTABLE_CARDS, MIN_SCALE)).toBe(MIN_SCALE); // stays readable
  });

  it('spreads a denser fan along a longer arc, up to a cap', () => {
    expect(fanRadius(10, 58, 7, 165)).toBeGreaterThan(fanRadius(2, 58, 7, 165));
    expect(fanRadius(100, 58, 7, 165)).toBe(165);
  });

  it('a single-card house sits straight, with no rotation to explain', () => {
    expect(houseFan(1)).toEqual([0]);
  });
});
