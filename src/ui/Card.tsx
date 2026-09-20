import type { Card } from '../types';

const SUIT_SYMBOL: Record<Card['suit'], string> = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };

/**
 * A playing card with the traditional two-corner index — rank over suit at the top-left, repeated
 * upside-down at the bottom-right. That's what makes a card identifiable when it's overlapped in a
 * fan with only its left edge showing, which in turn is what lets fans stay tight instead of
 * needing every card fully exposed.
 */
export function PlayingCard({
  card,
  selected,
  dimmed,
  playable,
  onClick
}: {
  card: Card;
  selected?: boolean;
  dimmed?: boolean;
  /** This card has at least one legal move right now — as decided by the engine, not by the card.
   * Drawn a little raised and fully bright, so a glance at the hand says which cards to consider. */
  playable?: boolean;
  onClick?: () => void;
}) {
  const isRed = card.suit === 'hearts' || card.suit === 'diamonds';
  const suit = SUIT_SYMBOL[card.suit];
  const classes = [
    'baazi-card',
    isRed ? 'is-red' : 'is-black',
    // The suit is named on the card as well as coloured by it, so the one place that decides what
    // a suit looks like is the stylesheet — see the four-colour note there.
    `is-${card.suit}`,
    selected ? 'is-selected' : '',
    dimmed ? 'is-dimmed' : '',
    playable ? 'is-playable' : '',
    onClick ? 'is-clickable' : ''
  ]
    .filter(Boolean)
    .join(' ');
  const Tag = onClick ? 'button' : 'div';

  return (
    <Tag
      className={classes}
      onClick={onClick}
      type={onClick ? 'button' : undefined}
      aria-label={onClick ? `${card.rank}${suit}` : undefined}
    >
      <span className="baazi-card-index">
        <span className="baazi-card-rank">{card.rank}</span>
        <span className="baazi-card-suit">{suit}</span>
      </span>
      <span className="baazi-card-index is-flipped" aria-hidden="true">
        <span className="baazi-card-rank">{card.rank}</span>
        <span className="baazi-card-suit">{suit}</span>
      </span>
    </Tag>
  );
}

/** Deep navy with a fine cream lattice. Chosen over a centred-motif and a dot-grid version by
 * putting all three on the actual felt: the motif read as a smudge at opponent-hand size and the
 * dots looked like graph paper, while the lattice holds its texture right down to a 26px sliver. */
export function CardBack() {
  return <div className="baazi-card baazi-card-back" aria-hidden="true" />;
}
