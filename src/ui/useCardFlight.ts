import { useCallback, useEffect, useRef, useState } from 'react';
import type { Card } from '../types';
import type { MoveReceipt } from './moveNarrative';

/**
 * The played card, crossing the table to wherever it actually went.
 *
 * A tap used to make a card vanish from the hand and something, somewhere, change — a pile count, a
 * house, the floor. Watching a round of real play, the commonest small confusion was simply not
 * knowing where a card had gone or what had just moved.
 *
 * It is a FLIP: the card's place in the hand is measured at the moment of the tap (before the state
 * changes and the slot disappears), the destination is measured after the move has landed, and the
 * card is flown between the two in a fixed overlay so nothing on the table reflows while it travels.
 *
 * Destinations are found by data attribute rather than by guessing at layout: `data-flight="floor"`,
 * `data-flight="pile:<playerId>"`, `data-house-id="<id>"`. A destination that is not on screen —
 * an opponent's pile in a four-handed game, say — simply means no flight, never a broken one.
 */

export interface Flight {
  card: Card;
  from: { x: number; y: number; width: number; height: number };
  to: { x: number; y: number };
}

const rectOf = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
};

function destinationFor(receipt: MoveReceipt, houseIds: string[]): Element | null {
  if (receipt.kind === 'capture' && receipt.actorId) {
    return document.querySelector(`[data-flight="pile:${CSS.escape(receipt.actorId)}"]`);
  }
  if (receipt.kind === 'build' || receipt.kind === 'cement' || receipt.kind === 'addToHouse' || receipt.kind === 'raise') {
    // The house that just changed is the newest one on the table; falling back to any house is
    // still better than no movement at all.
    for (const id of [...houseIds].reverse()) {
      const el = document.querySelector(`[data-house-id="${CSS.escape(id)}"]`);
      if (el) return el;
    }
    return null;
  }
  if (receipt.kind === 'throw') return document.querySelector('[data-flight="floor"]');
  return null;
}

export function useCardFlight(receipt: MoveReceipt | null, houseIds: string[], mySeat: string) {
  const pending = useRef<{ card: Card; from: Flight['from'] } | null>(null);
  const [flight, setFlight] = useState<Flight | null>(null);
  const [landing, setLanding] = useState(false);

  /** Called the instant a card is tapped, while its slot is still on screen to be measured. */
  const takeOff = useCallback((card: Card, element: Element | null) => {
    pending.current = element ? { card, from: rectOf(element) } : null;
  }, []);

  useEffect(() => {
    if (!receipt) return undefined;
    const start = pending.current;
    pending.current = null;
    // Only your own moves have a measured starting point; another player's card has no slot on this
    // screen to fly from, and inventing one would be a lie about where it came from.
    if (!start || receipt.actorId !== mySeat) return undefined;

    const target = destinationFor(receipt, houseIds);
    if (!target) return undefined;
    const to = rectOf(target);

    setFlight({
      card: start.card,
      from: start.from,
      to: { x: to.x + to.width / 2 - start.from.width / 2, y: to.y + to.height / 2 - start.from.height / 2 }
    });
    setLanding(false);

    const raf = requestAnimationFrame(() => setLanding(true));
    const done = window.setTimeout(() => setFlight(null), 480);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(done);
    };
    // Each receipt is one move; houseIds only matters at the moment the receipt arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt, mySeat]);

  return { flight, landing, takeOff };
}
