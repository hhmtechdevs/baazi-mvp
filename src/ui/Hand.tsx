import { useCallback, useEffect, useRef, useState } from 'react';
import type { Card } from '../types';

/** Card footprint, matching .baazi-card in the stylesheet. */
const CARD_WIDTH = 52;

/** How far from a card the pointer starts affecting it. Smaller = tighter, more local response. */
const INFLUENCE = 86;
/** How far the card nearest the pointer rises. */
const MAX_LIFT = 15;
/** How much it grows. Deliberately small — this is a card coming forward, not a zoom effect. */
const MAX_SCALE_BOOST = 0.13;
/** How far neighbours slide aside to open a gap around the pointer. Enough that the gap is
 * legible at a glance — the point is seeing the card you're about to take. */
const MAX_SPREAD = 26;
/** Extra lift for the card you've actually chosen, so it reads as picked up rather than hovered. */
const SELECTED_LIFT = 14;

/** Base arc: how much each card tilts per step from the middle, and how far the outer ones ride
 * lower. Shallow on purpose — a hand resting in front of you, not a poker rainbow. */
const ROTATION_PER_CARD = 1.9;
const MAX_ROTATION = 13;
const ARC_DROP = 0.9;

/** How much of a card's left edge must stay showing however tight things get — the corner index
 * lives there, and a card you can't name isn't a card you can play. */
const MIN_VISIBLE_EDGE = 15;

/**
 * How far each card tucks behind the one before it. A comfortable amount by default, tightened
 * only as far as necessary when the hand is wider than the space it has — which is what keeps a
 * twelve-card hand on a phone instead of running off both sides of the table.
 */
function overlapFor(count: number, available: number): number {
  const relaxed = count > 9 ? 22 : count > 6 ? 15 : count > 3 ? 8 : 2;
  if (count < 2 || available <= 0) return relaxed;
  if (CARD_WIDTH + (count - 1) * (CARD_WIDTH - relaxed) <= available) return relaxed;
  const step = (available - CARD_WIDTH) / (count - 1);
  return Math.min(CARD_WIDTH - MIN_VISIBLE_EDGE, CARD_WIDTH - step);
}

function clamp(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value));
}

/**
 * The player's hand, laid out and behaving like a Dock made of playing cards.
 *
 * The spatial idea borrowed from the Dock is proximity, not magnification-for-its-own-sake: every
 * card continuously responds to how near the pointer is, so the card you're reaching for rises and
 * straightens while its neighbours slide aside to open a gap around it. That "making room" is what
 * makes it feel like a hand of real cards rather than a row of buttons — you can see the card
 * you're about to take before you take it.
 *
 * Response falls off on a gaussian curve, so there's no hard hover boundary anywhere: move the
 * pointer and the whole hand answers smoothly. Nothing here is Apple's styling — no tray, no
 * panel, no chrome; the cards sit directly on the table.
 */
export function Hand({
  cards,
  selectedId,
  isActive = false,
  renderCard
}: {
  cards: Card[];
  selectedId: string | null;
  /** True while the table is waiting on this hand. Lifts the whole group a little — see the
   * .is-active rule in the stylesheet — underneath, and without disturbing, everything below. */
  isActive?: boolean;
  renderCard: (card: Card) => React.ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const frame = useRef<number | undefined>(undefined);
  const [pointerX, setPointerX] = useState<number | null>(null);
  const [rowWidth, setRowWidth] = useState(0);

  useEffect(() => () => { if (frame.current) cancelAnimationFrame(frame.current); }, []);

  // The row spans the space it's given, so its own width IS the space the hand has to fit into.
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return undefined;
    const observer = new ResizeObserver(entries => setRowWidth(entries[0].contentRect.width));
    observer.observe(row);
    return () => observer.disconnect();
  }, []);

  // Coalesced to one update per frame — pointermove fires far faster than the screen redraws.
  const track = useCallback((clientX: number) => {
    const row = rowRef.current;
    if (!row) return;
    const left = row.getBoundingClientRect().left;
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setPointerX(clientX - left));
  }, []);

  const count = cards.length;
  const overlap = overlapFor(count, rowWidth);
  const step = CARD_WIDTH - overlap;
  // The cards are centred in the row, so the first one doesn't start at the row's left edge —
  // and every proximity calculation below is measured from a card's centre.
  const leading = Math.max(0, (rowWidth - (CARD_WIDTH + Math.max(0, count - 1) * step)) / 2);

  return (
    <div
      ref={rowRef}
      className={`baazi-hand-dock ${isActive ? 'is-active' : ''}`}
      onPointerMove={event => track(event.clientX)}
      onPointerDown={event => track(event.clientX)}
      onPointerLeave={() => setPointerX(null)}
      onPointerCancel={() => setPointerX(null)}
    >
      {cards.map((card, i) => {
        const centre = leading + i * step + CARD_WIDTH / 2;
        const fromMiddle = i - (count - 1) / 2;

        // Signed, normalised distance from the pointer, and a smooth falloff around it.
        const distance = pointerX === null ? Infinity : (pointerX - centre) / INFLUENCE;
        const nearness = pointerX === null ? 0 : Math.exp(-distance * distance * 1.5);

        const isSelected = card.id === selectedId;
        const baseRotation = clamp(fromMiddle * ROTATION_PER_CARD, MAX_ROTATION);

        // Reaching for a card straightens it and lifts it; its neighbours lean away to make room.
        const rotation = baseRotation * (1 - 0.55 * nearness);
        const lift = fromMiddle * fromMiddle * ARC_DROP - MAX_LIFT * nearness - (isSelected ? SELECTED_LIFT : 0);
        const slide = pointerX === null ? 0 : -MAX_SPREAD * distance * nearness;
        const scale = 1 + MAX_SCALE_BOOST * nearness + (isSelected ? 0.05 : 0);

        return (
          <div
            key={card.id}
            className={`baazi-hand-slot ${isSelected ? 'is-selected' : ''}`}
            style={{
              marginLeft: i === 0 ? 0 : -overlap,
              transform: `translateX(${slide.toFixed(2)}px) translateY(${lift.toFixed(2)}px) rotate(${rotation.toFixed(2)}deg) scale(${scale.toFixed(3)})`,
              zIndex: (isSelected ? 2000 : 0) + Math.round(nearness * 1000) + i
            }}
          >
            {renderCard(card)}
          </div>
        );
      })}
    </div>
  );
}
