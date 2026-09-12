import { useState } from 'react';
import { PlayingCard } from './Card';
import { fanAngles, fanRadius, fanScale } from './fan';
import type { House as HouseType } from '../types';

/** Held-open fan shape. Tuned so two cards barely spread, and fifteen still arc rather than pile. */
const DEGREES_PER_CARD = 15;
const MAX_SPREAD = 150;
const COMFORTABLE_CARDS = 6;
const MIN_SCALE = 0.62;
const RADIUS_BASE = 58;
const RADIUS_PER_CARD = 7;
const RADIUS_MAX = 165;

/**
 * Which side owns this house, straight from the engine's own ownerSides — never inferred, never
 * modified here.
 *
 * An owner is an individual player id when one player owns the house outright, and a side id when
 * both sides have a stake (only reachable via a cross-side Cement/Add-to-Fixed) — so the caller
 * supplies every identifier that counts as yours, including your partner's, rather than one side
 * id to compare against. Two owners means shared.
 */
function ownership(
  house: HouseType,
  yourOwnerIds: string[],
  labelForOwner: (owner: string) => string
): { className: string; label: string } {
  const yours = house.ownerSides.some(owner => yourOwnerIds.includes(owner));
  const theirs = house.ownerSides.filter(owner => !yourOwnerIds.includes(owner));
  if (yours && theirs.length > 0) return { className: 'is-owner-both', label: 'Shared' };
  if (yours) return { className: 'is-owner-you', label: 'Yours' };
  if (theirs.length > 0) return { className: 'is-owner-theirs', label: `${labelForOwner(theirs[0])}'s` };
  return { className: '', label: '' };
}

/**
 * One house, in its own place on the table. Compact by default: its cards stacked into a pile with
 * a small ownership-coloured value pill above it.
 *
 * Press and hold it and the house fans its cards open in an arc — the digital version of picking a
 * house up off the table and spreading it in your hand. Release and it drops back. There is no
 * modal, no close control, and no shared browser across houses: holding this house opens exactly
 * this house, and every other house stays exactly where it is. The fan is drawn in an overlay
 * layer anchored to the tile, so nothing on the table reflows while it's open.
 *
 * Inspection only — it reads `house.cards` and changes nothing.
 */
export function House({
  house,
  yourOwnerIds,
  labelForOwner
}: {
  house: HouseType;
  yourOwnerIds: string[];
  labelForOwner: (owner: string) => string;
}) {
  const [held, setHeld] = useState(false);
  const owner = ownership(house, yourOwnerIds, labelForOwner);
  const count = house.cards.length;

  const angles = fanAngles(count, DEGREES_PER_CARD, MAX_SPREAD);
  const scale = fanScale(count, COMFORTABLE_CARDS, MIN_SCALE);
  const radius = fanRadius(count, RADIUS_BASE, RADIUS_PER_CARD, RADIUS_MAX);

  const hold = (event: React.PointerEvent<HTMLButtonElement>) => {
    setHeld(true);
    try {
      // Keeps the release reaching us even if the finger slides off the house mid-hold.
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* capture unavailable — pointerup/cancel still land on the element */
    }
  };
  const release = () => setHeld(false);

  return (
    <div className={`baazi-house-tile ${held ? 'is-held' : ''}`}>
      {held && (
        <div className="baazi-house-fan" aria-hidden="true">
          {house.cards.map((card, i) => (
            <div
              key={card.id}
              className="baazi-house-fan-slot"
              style={{ transform: `rotate(${angles[i]}deg)`, transformOrigin: `50% calc(100% + ${radius}px)`, zIndex: i }}
            >
              <div className="baazi-house-fan-card" style={{ transform: `scale(${scale})` }}>
                <PlayingCard card={card} />
              </div>
            </div>
          ))}
        </div>
      )}

      <span className={`baazi-house-pill ${owner.className}`}>
        {house.isCemented && (
          <span className="baazi-house-lock" aria-hidden="true">
            ⌾
          </span>
        )}
        {house.captureValue}
      </span>

      <button
        type="button"
        className={`baazi-house ${house.isCemented ? 'is-cemented' : ''} ${owner.className}`}
        onPointerDown={hold}
        onPointerUp={release}
        onPointerCancel={release}
        onContextMenu={event => event.preventDefault()}
        aria-label={`House of ${house.captureValue}, ${owner.label || 'unowned'}, ${count} cards. Press and hold to fan open.`}
      >
        {house.cards.map((card, i) => (
          <span key={card.id} className="baazi-house-card-slot" style={{ zIndex: i }}>
            <PlayingCard card={card} />
          </span>
        ))}
      </button>
    </div>
  );
}
