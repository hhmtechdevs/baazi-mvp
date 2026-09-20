import type { Card, CaptureTarget, GameState, House, OpeningAction, Player, Rank } from '../types';
import { assertCardInvariant } from './deal';

// ---------------------------------------------------------------------------
// Small internal helpers, mirroring the conventions established in deal.ts.
// No new physical-card-movement primitives are invented here beyond what
// deal.ts already established; this file adds RULE VALIDATION on top.
// ---------------------------------------------------------------------------

function requirePhase(state: GameState, phase: GameState['phase']): void {
  if (state.phase !== phase) {
    throw new Error(`Expected phase "${phase}" but game is in phase "${state.phase}".`);
  }
}

function getPlayer(state: GameState, playerId: string): Player {
  const player = state.players.find(p => p.id === playerId);
  if (!player) throw new Error(`Unknown player: ${playerId}`);
  return player;
}

function updatePlayer(state: GameState, playerId: string, changes: Partial<Player>): GameState {
  return {
    ...state,
    players: state.players.map(p => (p.id === playerId ? { ...p, ...changes } : p))
  };
}

const RANK_VALUES: Record<Rank, number> = {
  A: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13
};

function rankValue(rank: Rank): number {
  return RANK_VALUES[rank];
}

function findHouseContaining(state: GameState, cardId: string): House | undefined {
  return state.floor.houses.find(h => h.cards.some(c => c.id === cardId));
}

function hasDuplicates(ids: string[]): boolean {
  return new Set(ids).size !== ids.length;
}

/**
 * Whether `cards` can be partitioned into one or more disjoint groups, each summing to exactly
 * `target` — e.g. two independent loose 9s are both legitimately captured by a played 9 (each is
 * its own one-card group summing to 9), NOT a single group whose combined total must equal 9.
 * This mirrors the exact same "collect all compatible, non-overlapping combinations" rule
 * Ingredient 4 already discovers correctly (see legalMoves.ts and its "6b" regression test) —
 * this is a bounded, self-contained reimplementation scoped to what the OPENING floor can ever
 * contain (at most 4 loose cards, never houses, since none can exist yet on a freshly revealed
 * floor), not a general-purpose port of Ingredient 4's heavier machinery.
 */
function canPartitionSummingTo(cards: Card[], target: number): boolean {
  if (cards.length === 0) return true;
  const [first, ...rest] = cards;
  for (let mask = 0; mask < 1 << rest.length; mask++) {
    const group: Card[] = [first];
    const remaining: Card[] = [];
    for (let i = 0; i < rest.length; i++) {
      if ((mask >> i) & 1) group.push(rest[i]);
      else remaining.push(rest[i]);
    }
    const sum = group.reduce((s, c) => s + rankValue(c.rank), 0);
    if (sum === target && canPartitionSummingTo(remaining, target)) return true;
  }
  return false;
}

/**
 * Preconditions shared by every opening action: correct phase, a bid already exists, and only
 * the caller/bidder may submit the opening action.
 */
function requireOpeningPreconditions(state: GameState, playerId: string): void {
  requirePhase(state, 'revealing');
  if (state.bidValue === null || state.bidderId === null) {
    throw new Error('Cannot submit an opening action before a bid has been made and the floor revealed.');
  }
  if (playerId !== state.bidderId) {
    throw new Error(`Only the caller (${state.bidderId}) may make the opening play; got ${playerId}.`);
  }
}

// ---------------------------------------------------------------------------
// BUILD
// ---------------------------------------------------------------------------

function applyBuild(state: GameState, playerId: string, builderCardId: string, floorCardIds: string[]): GameState {
  const bidValue = state.bidValue as number;
  const bidder = getPlayer(state, playerId);

  const builderCard = bidder.hand.find(c => c.id === builderCardId);
  if (!builderCard) {
    throw new Error(`Card ${builderCardId} is not in your hand.`);
  }

  if (hasDuplicates(floorCardIds)) {
    throw new Error('The same floor card was selected more than once.');
  }

  const floorCards: Card[] = [];
  for (const id of floorCardIds) {
    const looseCard = state.floor.loose.find(c => c.id === id);
    if (looseCard) {
      floorCards.push(looseCard);
      continue;
    }
    if (findHouseContaining(state, id)) {
      throw new Error(`Card ${id} is part of an existing house, not a loose floor card. Houses cannot be used to build a new house.`);
    }
    throw new Error(`Card ${id} is not a loose card currently on the floor.`);
  }

  // Ingredient 3 validates the opening build independently of discovery, so it applies the same
  // rule itself: no card forms a house on its own, King included (see Ingredient 4's discovery).
  if (floorCards.length === 0) {
    throw new Error(
      `A ${builderCard.rank} on its own is a loose card, not a house. Build it together with a card from the floor, or play it as a loose card.`
    );
  }

  const total = rankValue(builderCard.rank) + floorCards.reduce((sum, c) => sum + rankValue(c.rank), 0);
  if (total !== bidValue) {
    throw new Error(`This build totals ${total}, but the bid is ${bidValue}. The build must total exactly the bid value.`);
  }

  const handAfterPlaying = bidder.hand.filter(c => c.id !== builderCardId);
  const retainsMatchingCard = handAfterPlaying.some(c => rankValue(c.rank) === bidValue);
  if (!retainsMatchingCard) {
    throw new Error(
      `Building this house would leave you without a card worth ${bidValue} to eventually capture it — the matching capture card must be retained, not spent on the build itself.`
    );
  }

  const house: House = {
    id: `house-${crypto.randomUUID()}`,
    // The opening play always creates a brand-new house (the floor has just been revealed with
    // no pre-existing houses to cement into), so ownership is trivially sole to the bidder — see
    // the Ingredient 4/5 Combine architecture notes for why ordinary houses store a single id
    // here while cemented houses can hold up to two (joint ownership).
    ownerSides: [playerId],
    cards: [...floorCards, builderCard],
    captureValue: bidValue,
    isCemented: false
  };

  const floorCardIdSet = new Set(floorCardIds);
  const nextState: GameState = {
    ...updatePlayer(state, playerId, { hand: handAfterPlaying }),
    floor: {
      loose: state.floor.loose.filter(c => !floorCardIdSet.has(c.id)),
      houses: [...state.floor.houses, house]
    },
    phase: 'opening'
  };

  assertCardInvariant(nextState);
  return nextState;
}

// ---------------------------------------------------------------------------
// CAPTURE
// ---------------------------------------------------------------------------

function applyCapture(state: GameState, playerId: string, bidCardId: string, targets: CaptureTarget[]): GameState {
  const bidValue = state.bidValue as number;
  const bidder = getPlayer(state, playerId);

  const bidCard = bidder.hand.find(c => c.id === bidCardId);
  if (!bidCard) {
    throw new Error(`Card ${bidCardId} is not in your hand.`);
  }
  if (rankValue(bidCard.rank) !== bidValue) {
    throw new Error(`Card ${bidCardId} (${bidCard.rank}) does not match the bid value of ${bidValue}.`);
  }
  if (!targets.length) {
    throw new Error('At least one capture target must be selected.');
  }

  const targetKeys = targets.map(t => (t.type === 'loose' ? `loose:${t.cardId}` : `house:${t.houseId}`));
  if (hasDuplicates(targetKeys)) {
    throw new Error('The same capture target was selected more than once.');
  }

  const capturedLooseCards: Card[] = [];
  const capturedHouses: House[] = [];
  const capturedHouseIds = new Set<string>();

  for (const target of targets) {
    if (target.type === 'loose') {
      const looseCard = state.floor.loose.find(c => c.id === target.cardId);
      if (looseCard) {
        capturedLooseCards.push(looseCard);
        continue;
      }
      if (findHouseContaining(state, target.cardId)) {
        throw new Error(
          `Card ${target.cardId} is part of a house, not a loose floor card. Reference the house by its own id to capture it.`
        );
      }
      throw new Error(`Card ${target.cardId} is not a loose card currently on the floor.`);
    } else {
      const house = state.floor.houses.find(h => h.id === target.houseId);
      if (!house) {
        throw new Error(`No house exists with id ${target.houseId}. A lone card of fixed value (e.g. a King) is a loose card, not a house.`);
      }
      capturedHouses.push(house);
      capturedHouseIds.add(house.id);
    }
  }

  // A house is never treated as a numeric contributor to a sum — it must match the bid value
  // exactly on its own (frozen rule, already correct elsewhere in the engine).
  if (capturedHouses.some(h => h.captureValue !== bidValue)) {
    throw new Error(`A captured house's value must exactly equal the bid value of ${bidValue}.`);
  }
  // The loose targets, taken together, must be exactly explainable as one or more disjoint
  // groups EACH summing to bidValue — e.g. two independent loose cards that each individually
  // equal bidValue are both captured together, never summed into one combined total. This is NOT
  // "the grand total of every target equals bidValue" (that was the bug: two loose 9s captured by
  // a played 9 would fail a total-must-equal-9 check, since 9+9=18, even though each 9 is its own
  // valid match).
  if (!canPartitionSummingTo(capturedLooseCards, bidValue)) {
    throw new Error(
      `Selected loose capture targets could not be grouped into one or more combinations each summing to the bid value of ${bidValue}.`
    );
  }

  const capturedLooseIds = new Set(capturedLooseCards.map(c => c.id));
  const allCapturedCards: Card[] = [
    bidCard,
    ...capturedLooseCards,
    ...capturedHouses.flatMap(h => h.cards)
  ];

  const nextState: GameState = {
    ...updatePlayer(state, playerId, {
      hand: bidder.hand.filter(c => c.id !== bidCardId),
      captured: [...bidder.captured, ...allCapturedCards]
    }),
    floor: {
      loose: state.floor.loose.filter(c => !capturedLooseIds.has(c.id)),
      houses: state.floor.houses.filter(h => !capturedHouseIds.has(h.id))
    },
    phase: 'opening'
  };

  assertCardInvariant(nextState);
  return nextState;
}

// ---------------------------------------------------------------------------
// THROW
// ---------------------------------------------------------------------------

function applyThrow(state: GameState, playerId: string, bidCardId: string): GameState {
  const bidValue = state.bidValue as number;
  const bidder = getPlayer(state, playerId);

  const bidCard = bidder.hand.find(c => c.id === bidCardId);
  if (!bidCard) {
    throw new Error(`Card ${bidCardId} is not in your hand.`);
  }
  if (rankValue(bidCard.rank) !== bidValue) {
    throw new Error(`Card ${bidCardId} (${bidCard.rank}) does not match the bid value of ${bidValue}.`);
  }

  const nextState: GameState = {
    ...updatePlayer(state, playerId, { hand: bidder.hand.filter(c => c.id !== bidCardId) }),
    floor: { ...state.floor, loose: [...state.floor.loose, bidCard] },
    phase: 'opening'
  };

  assertCardInvariant(nextState);
  return nextState;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Validates and applies an explicit, player-chosen opening action (build, capture, or throw).
 *
 * This function is a referee, not a strategist: it checks exactly the action the player asked
 * for and either applies it or rejects it with a specific reason. It never substitutes a
 * different action, never picks the "better" move, and never applies partial/automatic
 * behavior on the player's behalf.
 *
 * Requires phase 'revealing' (a bid exists and the floor has been revealed) and that `playerId`
 * is the caller/bidder. On success, transitions phase to 'opening'. Turn progression beyond
 * that is out of scope for this ingredient.
 */
export function submitOpeningAction(state: GameState, playerId: string, action: OpeningAction): GameState {
  requireOpeningPreconditions(state, playerId);
  switch (action.type) {
    case 'build':
      return applyBuild(state, playerId, action.builderCardId, action.floorCardIds);
    case 'capture':
      return applyCapture(state, playerId, action.bidCardId, action.targets);
    case 'throw':
      return applyThrow(state, playerId, action.bidCardId);
  }
}
