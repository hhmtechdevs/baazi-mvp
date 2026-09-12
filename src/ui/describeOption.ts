import type { Card, GameState } from '../types';
import type { LegalOption } from '../engine/legalMoves';

const SUIT_SYMBOL: Record<Card['suit'], string> = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };

const RANK_VALUE: Record<Card['rank'], number> = {
  A: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13
};

/** Every place a card referenced by an option can physically be: the floor, inside a house, or —
 * for the played card itself — in someone's hand. */
function findCard(state: GameState, id: string): Card | undefined {
  return (
    state.floor.loose.find(c => c.id === id) ??
    state.floor.houses.flatMap(h => h.cards).find(c => c.id === id) ??
    state.players.flatMap(p => p.hand).find(c => c.id === id)
  );
}

const LETTER_RANKS: ReadonlySet<Card['rank']> = new Set(['A', 'J', 'Q', 'K']);

/**
 * A card as a term in a move's equation.
 *
 * Aces and court cards keep their letter and always carry their suit — `A♠`, `J♣`, `Q♦`, `K♥` —
 * because that's how you'd name them at the table, and a bare "11" doesn't read as a Jack. Number
 * cards are just their number; they only pick up a suit when it's needed to tell two otherwise
 * identical options apart (see labelLegalOptions).
 *
 * Totals on the other side of the `=` stay numeric regardless: a house is a value, not a card.
 */
function cardTerm(card: Card, withSuit: boolean): string {
  const suit = SUIT_SYMBOL[card.suit];
  if (LETTER_RANKS.has(card.rank)) return `${card.rank}${suit}`;
  return withSuit ? `${RANK_VALUE[card.rank]}${suit}` : String(RANK_VALUE[card.rank]);
}

/** Houses are bracketed so an existing house on the floor never reads as a loose card: `[11]`. */
function houseTerm(state: GameState, houseId: string): string {
  const house = state.floor.houses.find(h => h.id === houseId);
  return house ? `[${house.captureValue}]` : '[?]';
}

/**
 * The played card is always shown, even when it needs no help from the floor to reach the value —
 * the opening panel lists options across every card in hand, so dropping it would leave two
 * different cards ("play the Q♣" vs "play the Q♥") reading as the same button. A lone term needs
 * no brackets, since there's nothing being combined.
 */
function equation(terms: string[], result: string, absorbed: string[] = []): string {
  const sum = terms.length <= 1 ? `${terms[0] ?? '?'} = ${result}` : `(${terms.join(' + ')}) = ${result}`;
  // Absorbed cards are NOT addends of this sum — each is its own loose group that already equals
  // the same value and gets swept in automatically once the move is chosen. Folding them into the
  // equation would print arithmetic that doesn't add up (e.g. "(11 + 4 + 7) = 11"), so they're
  // parenthesised after it instead. The brackets matter: plain spacing collapses in HTML, leaving
  // "13 +7+5" looking like part of the sum.
  return absorbed.length === 0 ? sum : `${sum} (+${absorbed.join(' +')})`;
}

/**
 * A compact label for one discovered legal option — values and arithmetic, not prose. Every
 * house-making move reads as the equation it actually is: `(5 + 6) = 11`, where the first term is
 * the card being played and `[n]` marks an existing house on the floor rather than a loose card.
 * Captures keep a one-word verb because "take these cards" and "make a house out of these cards"
 * can involve the exact same cards and must stay tellable apart.
 *
 * Purely descriptive — computed from the option's own already-legal contents, never re-deriving
 * whether the option is legal.
 */
export function describeLegalOption(option: LegalOption, state: GameState, withSuits = false): string {
  const card = (id: string) => {
    const found = findCard(state, id);
    return found ? cardTerm(found, withSuits) : '?';
  };
  const house = (id: string) => houseTerm(state, id);

  switch (option.kind) {
    case 'build':
      return equation(
        [card(option.handCardId), ...option.floorCardIds.map(card)],
        String(option.resultingValue),
        option.absorbedLooseCardIds.map(card)
      );
    case 'cement':
    case 'addToFixed':
      // Lands on a house that already exists at this value, so the result side names that house.
      return equation(
        [card(option.handCardId), ...option.floorCardIds.map(card)],
        house(option.existingHouseId),
        option.absorbedLooseCardIds.map(card)
      );
    case 'break':
      // Raises an existing house to a new value nothing occupies yet.
      return equation(
        [house(option.existingHouseId), card(option.handCardId)],
        String(option.resultingValue),
        option.absorbedLooseCardIds.map(card)
      );
    case 'mergeFix':
      // Raises an existing house into another house already sitting at the new value.
      return equation(
        [house(option.existingHouseId), card(option.handCardId)],
        house(option.targetHouseId),
        option.absorbedLooseCardIds.map(card)
      );
    case 'capture': {
      const parts = option.targets.map(target =>
        target.type === 'loose' ? card(target.cardId) : house(target.houseId)
      );
      return `Take ${parts.join(' + ')}${option.isSeep ? ' · Seep' : ''}`;
    }
    case 'throw':
      return 'Throw';
  }
}

/**
 * Labels for a whole set of options rendered together, with suits added back ONLY where two
 * options would otherwise carry the same label. Two genuinely different moves can use different
 * cards of the same value (e.g. taking 2♦+4 vs 2♥+4 when both 2s are on the floor), and those must
 * stay distinguishable — but the common case shouldn't pay for the rare one with permanent extra
 * glyphs on every button.
 */
export function labelLegalOptions(options: LegalOption[], state: GameState): string[] {
  const plain = options.map(option => describeLegalOption(option, state, false));
  const occurrences = new Map<string, number>();
  for (const label of plain) occurrences.set(label, (occurrences.get(label) ?? 0) + 1);
  return options.map((option, i) =>
    (occurrences.get(plain[i]) ?? 0) > 1 ? describeLegalOption(option, state, true) : plain[i]
  );
}
