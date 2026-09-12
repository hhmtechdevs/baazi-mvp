import type { Card, CaptureTarget, GameState, House, Player, SweepRecord } from '../types';
import { discoverLegalOptions } from './legalMoves';
import { assertCardInvariant } from './deal';
import { advanceAfterMove, advanceAfterOpeningAction } from './turnProgression';

// ---------------------------------------------------------------------------
// Small internal helpers (re-declared here rather than imported from other
// ingredient files, per the convention already established in this project —
// each ingredient stays self-contained and doesn't reach into another's
// private internals).
// ---------------------------------------------------------------------------

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

function requirePhase(state: GameState, phase: GameState['phase']): void {
  if (state.phase !== phase) {
    throw new Error(`Expected phase "${phase}" but game is in phase "${state.phase}".`);
  }
}

function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every(id => setA.has(id));
}

function captureTargetKey(t: CaptureTarget): string {
  return t.type === 'loose' ? `loose:${t.cardId}` : `house:${t.houseId}`;
}

/**
 * Removes every card whose id is in `removedIds` from `loose`. Shared by every house-landing
 * action (Build/Cement/MergeFix/Add-to-Fixed all remove their primary combo plus whatever the
 * discovery layer already decided to absorb).
 */
function removeFromLoose(loose: Card[], removedIds: Set<string>): Card[] {
  return loose.filter(c => !removedIds.has(c.id));
}

// ---------------------------------------------------------------------------
// BUILD — creates a brand-new house. All rule work (does this combo reach a valid value, does
// the acting player retain a key, which additional loose combinations get absorbed) was already
// decided by Ingredient 4's discovery; this only re-validates the exact request against it and
// then mechanically applies exactly what was discovered. Per the frozen architecture, Ingredient
// 5 never re-derives ownership, key requirements, or absorption itself.
// ---------------------------------------------------------------------------

function executeBuild(state: GameState, playerId: string, handCardId: string, floorCardIds: string[], absorbedLooseCardIds: string[]): GameState {
  const matched = discoverLegalOptions(state, playerId, handCardId).find(
    (o): o is Extract<typeof o, { kind: 'build' }> =>
      o.kind === 'build' && sameIdSet(o.floorCardIds, floorCardIds) && sameIdSet(o.absorbedLooseCardIds, absorbedLooseCardIds)
  );
  if (!matched) throw new Error('That build is not currently legal.');

  const player = getPlayer(state, playerId);
  const handCard = player.hand.find(c => c.id === handCardId) as Card;
  const removedIds = new Set([...matched.floorCardIds, ...matched.absorbedLooseCardIds]);
  const movedCards = state.floor.loose.filter(c => removedIds.has(c.id));

  const house: House = {
    id: `house-${crypto.randomUUID()}`,
    ownerSides: matched.resultingOwnerSides,
    cards: [...movedCards, handCard],
    captureValue: matched.resultingValue,
    isCemented: matched.absorbedLooseCardIds.length > 0
  };

  const nextState: GameState = {
    ...updatePlayer(state, playerId, { hand: player.hand.filter(c => c.id !== handCardId) }),
    floor: { loose: removeFromLoose(state.floor.loose, removedIds), houses: [...state.floor.houses, house] }
  };
  assertCardInvariant(nextState);
  return nextState;
}

// ---------------------------------------------------------------------------
// CEMENT — adds the played card (plus any combo/absorbed loose cards) to an already-existing
// ORDINARY house at the same value, transitioning it to cemented. Ownership is exactly what
// discovery already computed (sole if cementer and prior owner share a side, joint otherwise —
// the frozen Baazi joint-ownership rule).
// ---------------------------------------------------------------------------

function executeCement(
  state: GameState,
  playerId: string,
  handCardId: string,
  floorCardIds: string[],
  existingHouseId: string,
  absorbedLooseCardIds: string[]
): GameState {
  const matched = discoverLegalOptions(state, playerId, handCardId).find(
    (o): o is Extract<typeof o, { kind: 'cement' }> =>
      o.kind === 'cement' &&
      o.existingHouseId === existingHouseId &&
      sameIdSet(o.floorCardIds, floorCardIds) &&
      sameIdSet(o.absorbedLooseCardIds, absorbedLooseCardIds)
  );
  if (!matched) throw new Error('That cement is not currently legal.');

  const existingHouse = state.floor.houses.find(h => h.id === existingHouseId);
  if (!existingHouse) throw new Error(`No house exists with id ${existingHouseId}.`);

  const player = getPlayer(state, playerId);
  const handCard = player.hand.find(c => c.id === handCardId) as Card;
  const removedIds = new Set([...matched.floorCardIds, ...matched.absorbedLooseCardIds]);
  const movedCards = state.floor.loose.filter(c => removedIds.has(c.id));

  const merged: House = {
    ...existingHouse,
    cards: [...existingHouse.cards, ...movedCards, handCard],
    isCemented: true,
    ownerSides: matched.resultingOwnerSides
  };

  const nextState: GameState = {
    ...updatePlayer(state, playerId, { hand: player.hand.filter(c => c.id !== handCardId) }),
    floor: {
      loose: removeFromLoose(state.floor.loose, removedIds),
      houses: state.floor.houses.map(h => (h.id === existingHouseId ? merged : h))
    }
  };
  assertCardInvariant(nextState);
  return nextState;
}

// ---------------------------------------------------------------------------
// BREAK — raises an existing ORDINARY house's value by playing a card directly onto it (no
// pre-existing house currently occupies the new value). Ownership transfers solely to the
// individual who made the change, per the frozen "changer becomes owner" rule — distinct from
// Cement's side-union rule, since this is a value-changing action, not a same-value placement.
// ---------------------------------------------------------------------------

function executeBreak(state: GameState, playerId: string, handCardId: string, existingHouseId: string, absorbedLooseCardIds: string[]): GameState {
  const matched = discoverLegalOptions(state, playerId, handCardId).find(
    (o): o is Extract<typeof o, { kind: 'break' }> =>
      o.kind === 'break' && o.existingHouseId === existingHouseId && sameIdSet(o.absorbedLooseCardIds, absorbedLooseCardIds)
  );
  if (!matched) throw new Error('That break is not currently legal.');

  const brokenHouse = state.floor.houses.find(h => h.id === existingHouseId);
  if (!brokenHouse) throw new Error(`No house exists with id ${existingHouseId}.`);

  const player = getPlayer(state, playerId);
  const handCard = player.hand.find(c => c.id === handCardId) as Card;
  const absorbedIds = new Set(matched.absorbedLooseCardIds);
  const absorbedCards = state.floor.loose.filter(c => absorbedIds.has(c.id));

  const raised: House = {
    id: `house-${crypto.randomUUID()}`,
    ownerSides: matched.resultingOwnerSides,
    cards: [...brokenHouse.cards, ...absorbedCards, handCard],
    captureValue: matched.resultingValue,
    isCemented: matched.absorbedLooseCardIds.length > 0
  };

  const nextState: GameState = {
    ...updatePlayer(state, playerId, { hand: player.hand.filter(c => c.id !== handCardId) }),
    floor: {
      loose: removeFromLoose(state.floor.loose, absorbedIds),
      houses: [...state.floor.houses.filter(h => h.id !== existingHouseId), raised]
    }
  };
  assertCardInvariant(nextState);
  return nextState;
}

// ---------------------------------------------------------------------------
// MERGE+FIX — raises an existing ORDINARY house's value onto a value where ANOTHER house already
// sits, merging both into one and cementing it immediately (merging two houses is itself the
// cementing trigger, unconditionally — matching the original frozen "if that change causes
// cementing, the player who made the change remains the owner" rule). Sole ownership to the
// changer, same as plain Break — this is still fundamentally a value-changing action.
// ---------------------------------------------------------------------------

function executeMergeFix(
  state: GameState,
  playerId: string,
  handCardId: string,
  existingHouseId: string,
  absorbedLooseCardIds: string[]
): GameState {
  const matched = discoverLegalOptions(state, playerId, handCardId).find(
    (o): o is Extract<typeof o, { kind: 'mergeFix' }> =>
      o.kind === 'mergeFix' && o.existingHouseId === existingHouseId && sameIdSet(o.absorbedLooseCardIds, absorbedLooseCardIds)
  );
  if (!matched) throw new Error('That merge+fix is not currently legal.');

  const brokenHouse = state.floor.houses.find(h => h.id === existingHouseId);
  const targetHouse = state.floor.houses.find(h => h.id === matched.targetHouseId);
  if (!brokenHouse) throw new Error(`No house exists with id ${existingHouseId}.`);
  if (!targetHouse) throw new Error(`No house exists with id ${matched.targetHouseId}.`);

  const player = getPlayer(state, playerId);
  const handCard = player.hand.find(c => c.id === handCardId) as Card;
  const absorbedIds = new Set(matched.absorbedLooseCardIds);
  const absorbedCards = state.floor.loose.filter(c => absorbedIds.has(c.id));

  const merged: House = {
    id: `house-${crypto.randomUUID()}`,
    ownerSides: matched.resultingOwnerSides,
    cards: [...brokenHouse.cards, ...targetHouse.cards, ...absorbedCards, handCard],
    captureValue: matched.resultingValue,
    isCemented: true
  };

  const nextState: GameState = {
    ...updatePlayer(state, playerId, { hand: player.hand.filter(c => c.id !== handCardId) }),
    floor: {
      loose: removeFromLoose(state.floor.loose, absorbedIds),
      houses: [...state.floor.houses.filter(h => h.id !== existingHouseId && h.id !== matched.targetHouseId), merged]
    }
  };
  assertCardInvariant(nextState);
  return nextState;
}

// ---------------------------------------------------------------------------
// ADD-TO-FIXED — adds another matching-value card (plus any combo/absorbed loose cards) to an
// already-cemented house. Value and ownership never change (frozen) — this is purely additive.
// ---------------------------------------------------------------------------

function executeAddToFixed(
  state: GameState,
  playerId: string,
  handCardId: string,
  floorCardIds: string[],
  existingHouseId: string,
  absorbedLooseCardIds: string[]
): GameState {
  const matched = discoverLegalOptions(state, playerId, handCardId).find(
    (o): o is Extract<typeof o, { kind: 'addToFixed' }> =>
      o.kind === 'addToFixed' &&
      o.existingHouseId === existingHouseId &&
      sameIdSet(o.floorCardIds, floorCardIds) &&
      sameIdSet(o.absorbedLooseCardIds, absorbedLooseCardIds)
  );
  if (!matched) throw new Error('That add-to-fixed is not currently legal.');

  const existingHouse = state.floor.houses.find(h => h.id === existingHouseId);
  if (!existingHouse) throw new Error(`No house exists with id ${existingHouseId}.`);

  const player = getPlayer(state, playerId);
  const handCard = player.hand.find(c => c.id === handCardId) as Card;
  const removedIds = new Set([...matched.floorCardIds, ...matched.absorbedLooseCardIds]);
  const movedCards = state.floor.loose.filter(c => removedIds.has(c.id));

  const updated: House = {
    ...existingHouse,
    cards: [...existingHouse.cards, ...movedCards, handCard]
    // isCemented and ownerSides are deliberately untouched — Add-to-Fixed never changes either.
  };

  const nextState: GameState = {
    ...updatePlayer(state, playerId, { hand: player.hand.filter(c => c.id !== handCardId) }),
    floor: {
      loose: removeFromLoose(state.floor.loose, removedIds),
      houses: state.floor.houses.map(h => (h.id === existingHouseId ? updated : h))
    }
  };
  assertCardInvariant(nextState);
  return nextState;
}

// ---------------------------------------------------------------------------
// CAPTURE — re-validated against, and executed from, Ingredient 4's already-
// correct discovery (including its isSeep flag, reused rather than recomputed).
// UNCHANGED by the Combine/Cement architecture work.
// ---------------------------------------------------------------------------

function executeCapture(
  state: GameState,
  playerId: string,
  handCardId: string,
  targets: CaptureTarget[]
): { state: GameState; isSeep: boolean } {
  const options = discoverLegalOptions(state, playerId, handCardId).filter(o => o.kind === 'capture');
  const requestedKeys = new Set(targets.map(captureTargetKey));
  const matched = options.find(o => {
    if (o.kind !== 'capture') return false;
    const optionKeys = o.targets.map(captureTargetKey);
    return optionKeys.length === requestedKeys.size && optionKeys.every(k => requestedKeys.has(k));
  });
  if (!matched || matched.kind !== 'capture') {
    throw new Error('That capture is not currently legal.');
  }

  const player = getPlayer(state, playerId);
  const handCard = player.hand.find(c => c.id === handCardId) as Card;
  const looseIds = new Set(matched.targets.filter(t => t.type === 'loose').map(t => (t as { cardId: string }).cardId));
  const houseIds = new Set(matched.targets.filter(t => t.type === 'house').map(t => (t as { houseId: string }).houseId));
  const capturedLoose = state.floor.loose.filter(c => looseIds.has(c.id));
  const capturedHouseCards = state.floor.houses.filter(h => houseIds.has(h.id)).flatMap(h => h.cards);
  const allCaptured = [handCard, ...capturedLoose, ...capturedHouseCards];

  const nextState: GameState = {
    ...updatePlayer(state, playerId, {
      hand: player.hand.filter(c => c.id !== handCardId),
      captured: [...player.captured, ...allCaptured]
    }),
    floor: {
      loose: state.floor.loose.filter(c => !looseIds.has(c.id)),
      houses: state.floor.houses.filter(h => !houseIds.has(h.id))
    }
  };
  assertCardInvariant(nextState);
  return { state: nextState, isSeep: matched.isSeep };
}

// ---------------------------------------------------------------------------
// THROW — UNCHANGED by the Combine/Cement architecture work.
// ---------------------------------------------------------------------------

function executeThrow(state: GameState, playerId: string, handCardId: string): GameState {
  const options = discoverLegalOptions(state, playerId, handCardId);
  if (!options.some(o => o.kind === 'throw')) {
    throw new Error('Throwing this card is not currently legal.');
  }
  const player = getPlayer(state, playerId);
  const handCard = player.hand.find(c => c.id === handCardId) as Card;
  const nextState: GameState = {
    ...updatePlayer(state, playerId, { hand: player.hand.filter(c => c.id !== handCardId) }),
    floor: { ...state.floor, loose: [...state.floor.loose, handCard] }
  };
  assertCardInvariant(nextState);
  return nextState;
}

// ---------------------------------------------------------------------------
// Sweep detection — UNCHANGED by the Combine/Cement architecture work. House-landing/raising
// actions never trigger a sweep (they place cards on the floor, they never empty it) — only
// Capture can.
// ---------------------------------------------------------------------------

function isFloorEmpty(state: GameState): boolean {
  return state.floor.loose.length === 0 && state.floor.houses.length === 0;
}

// Defined as: after this move, every player's hand AND reserve are empty everywhere — i.e.
// this was the literal last card played in the round. The frozen contract doesn't spell out
// the detection mechanism explicitly; this is the interpretation used here (see report).
function isFinalPlay(state: GameState): boolean {
  return state.players.every(p => p.hand.length === 0 && p.reserve.length === 0);
}

function recordSweepIfNeeded(state: GameState, playerId: string, isOpeningPlay: boolean): GameState {
  if (!isFloorEmpty(state)) return state;
  const player = getPlayer(state, playerId);
  const record: SweepRecord = {
    playerId,
    teamId: player.teamId,
    roundNumber: state.roundNumber,
    isOpeningPlay,
    isFinalPlay: isFinalPlay(state)
  };
  // No scoring is applied here — this only records the fact and its category for a later
  // scoring ingredient to consume.
  return { ...state, sweepRecords: [...state.sweepRecords, record] };
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

// `absorbedLooseCardIds` disambiguates WHICH non-overlapping absorption alternative the player
// means, whenever more than one exists for the same primary combo/house (the same "collect
// everything compatible, but choose between overlapping alternatives" rule already established
// for capture — see legalMoves.ts's collectAllCompatibleCombinations). Without this field,
// execution would have no way to tell two otherwise-identical discovered options apart and would
// silently execute whichever discovery happened to list first — exactly the guessing the frozen
// rules prohibit.
export type NormalPlayMove =
  | { kind: 'build'; handCardId: string; floorCardIds: string[]; absorbedLooseCardIds: string[] }
  | { kind: 'cement'; handCardId: string; floorCardIds: string[]; existingHouseId: string; absorbedLooseCardIds: string[] }
  | { kind: 'break'; handCardId: string; existingHouseId: string; absorbedLooseCardIds: string[] }
  | { kind: 'mergeFix'; handCardId: string; existingHouseId: string; absorbedLooseCardIds: string[] }
  | { kind: 'addToFixed'; handCardId: string; floorCardIds: string[]; existingHouseId: string; absorbedLooseCardIds: string[] }
  | { kind: 'capture'; handCardId: string; targets: CaptureTarget[] }
  | { kind: 'throw'; handCardId: string };

/**
 * Executes one normal-play move (post-opening). Every one of Build/Cement/Break/MergeFix/
 * Add-to-Fixed/Capture/Throw is validated against Ingredient 4's discovery — this function never
 * re-derives legality, ownership, key-responsibility, or absorption itself; it only matches the
 * requested move against what discovery already computed and mechanically applies it. Records a
 * sweep if a capture emptied the floor (Ingredient 5's own consequence), then delegates turn/hand
 * progression to Ingredient 6's turnProgression module — the sole authoritative place that
 * decides who plays next, so this never advances the turn itself. An illegal request throws and
 * never mutates state.
 */
export function executeMove(state: GameState, playerId: string, move: NormalPlayMove): GameState {
  requirePhase(state, 'playing');
  const current = state.players[state.currentPlayerIndex];
  if (!current || current.id !== playerId) {
    throw new Error(`It is not ${playerId}'s turn.`);
  }

  let afterAction: GameState;
  let isSeep = false;

  if (move.kind === 'build') {
    afterAction = executeBuild(state, playerId, move.handCardId, move.floorCardIds, move.absorbedLooseCardIds);
  } else if (move.kind === 'cement') {
    afterAction = executeCement(state, playerId, move.handCardId, move.floorCardIds, move.existingHouseId, move.absorbedLooseCardIds);
  } else if (move.kind === 'break') {
    afterAction = executeBreak(state, playerId, move.handCardId, move.existingHouseId, move.absorbedLooseCardIds);
  } else if (move.kind === 'mergeFix') {
    afterAction = executeMergeFix(state, playerId, move.handCardId, move.existingHouseId, move.absorbedLooseCardIds);
  } else if (move.kind === 'addToFixed') {
    afterAction = executeAddToFixed(state, playerId, move.handCardId, move.floorCardIds, move.existingHouseId, move.absorbedLooseCardIds);
  } else if (move.kind === 'capture') {
    const result = executeCapture(state, playerId, move.handCardId, move.targets);
    afterAction = result.state;
    isSeep = result.isSeep;
  } else {
    afterAction = executeThrow(state, playerId, move.handCardId);
  }

  if (isSeep) {
    afterAction = recordSweepIfNeeded(afterAction, playerId, false);
  }

  return advanceAfterMove(afterAction, playerId, move.kind === 'capture');
}

/**
 * Bridges Ingredient 3 to Ingredient 5/6 without modifying the frozen opening-action code: call
 * this once, immediately after a successful `submitOpeningAction` (phase will be 'opening'),
 * passing whether that action was a capture (the caller already knows this from the
 * `OpeningAction` they submitted). Detects an opening sweep if the opening capture emptied the
 * floor, transitions phase to 'playing', and delegates to Ingredient 6's turnProgression module
 * to find the next player — explicitly derived from `bidderId`, not from whatever
 * `currentPlayerIndex` happened to already be (see the Ingredient 6 report for why).
 */
export function finalizeOpeningAndAdvance(state: GameState, actingPlayerId: string, wasCapture: boolean): GameState {
  requirePhase(state, 'opening');
  let next = state;
  if (isFloorEmpty(next)) {
    next = recordSweepIfNeeded(next, actingPlayerId, true);
  }
  next = { ...next, phase: 'playing' };
  return advanceAfterOpeningAction(next, wasCapture);
}
