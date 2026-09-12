/**
 * Geometry for a house held open — the arc its cards spread into while your finger is on it.
 *
 * Purely presentational: nothing here reads or produces game state.
 */

/**
 * Rotation for each card in a fan, in degrees, centred on zero.
 *
 * The total spread is capped, so adding cards tightens the gaps between them instead of growing
 * the fan without limit — a 15-card house stays roughly as wide as a 10-card one, just denser.
 */
export function fanAngles(count: number, degreesPerCard: number, maxSpread: number): number[] {
  if (count <= 1) return [0];
  const spread = Math.min(maxSpread, degreesPerCard * (count - 1));
  const step = spread / (count - 1);
  return Array.from({ length: count }, (_, i) => -spread / 2 + i * step);
}

/**
 * How much to shrink cards once a fan gets crowded. Up to `comfortable` cards they stay full size;
 * past that they scale down gently so the whole fan keeps a sane footprint — the corner indices
 * stay readable well below full size, which is the whole reason cards have corner indices.
 */
export function fanScale(count: number, comfortable: number, minScale: number): number {
  if (count <= comfortable) return 1;
  return Math.max(minScale, 1 - (count - comfortable) * 0.04);
}

/**
 * Distance from a card's bottom edge down to the pivot the fan rotates around. Bigger radius =
 * flatter arc. It grows with the card count so a dense fan spreads along a longer arc instead of
 * bunching its cards on top of each other.
 */
export function fanRadius(count: number, base: number, perCard: number, max: number): number {
  return Math.min(max, base + count * perCard);
}
