import { PlayingCard } from './Card';
import { looseGap, scatterFor } from './scatter';
import type { Card } from '../types';

/**
 * The cards still lying on the blanket.
 *
 * Deliberately NOT a fan and NOT a stack. A house is something a player built; these are cards
 * nobody has picked up, and on a real table they end up standing around separately — near each
 * other, at slightly different angles, each one still its own card. Every one of them has to stay
 * individually readable, because "what is on the floor" is the single most important thing to be
 * able to answer at a glance.
 *
 * Each card's small displacement comes from its own id (see scatter.ts), so it keeps the spot it
 * landed in across every re-render instead of shuffling itself on each move.
 */
export function LooseFloor({ cards }: { cards: Card[] }) {
  const gap = looseGap(cards.length);

  return (
    // The gap goes out as a custom property rather than a fixed column-gap, so the stylesheet can
    // cap it against the actual width of the table — a spread that reads as "scattered" on a
    // laptop would push the same few cards onto two rows on a phone.
    <div className="baazi-loose-floor" style={{ '--loose-gap': `${gap}px` } as React.CSSProperties}>
      {cards.map(card => {
        const { dx, dy, rotate } = scatterFor(card.id);
        return (
          <div
            key={card.id}
            className="baazi-loose-card"
            style={{ transform: `translate(${dx}px, ${dy}px) rotate(${rotate}deg)` }}
          >
            <PlayingCard card={card} />
          </div>
        );
      })}
    </div>
  );
}
