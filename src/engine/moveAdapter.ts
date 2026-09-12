import type { OpeningAction } from '../types';
import type { LegalOption } from './legalMoves';
import type { NormalPlayMove } from './moveExecution';
import type { OrchestratedGame } from './roundOrchestrator';

// ---------------------------------------------------------------------------
// New, additive utility — not a change to any frozen ingredient. Ingredient 4 discovers options
// shaped as `LegalOption`; Ingredient 5's `executeMove` and Ingredient 3's `submitOpeningAction`
// each expect their own distinct submitted-move shape. Every real client of the orchestrator (the
// bot, the UI) needs to convert one into the other, so this lives once here rather than being
// reimplemented in both places.
// ---------------------------------------------------------------------------

/** Converts a discovered normal-play option into the exact move `submitMove` expects. */
export function toNormalPlayMove(option: LegalOption): NormalPlayMove {
  switch (option.kind) {
    case 'build':
      return { kind: 'build', handCardId: option.handCardId, floorCardIds: option.floorCardIds, absorbedLooseCardIds: option.absorbedLooseCardIds };
    case 'cement':
      return {
        kind: 'cement',
        handCardId: option.handCardId,
        floorCardIds: option.floorCardIds,
        existingHouseId: option.existingHouseId,
        absorbedLooseCardIds: option.absorbedLooseCardIds
      };
    case 'break':
      return { kind: 'break', handCardId: option.handCardId, existingHouseId: option.existingHouseId, absorbedLooseCardIds: option.absorbedLooseCardIds };
    case 'mergeFix':
      return { kind: 'mergeFix', handCardId: option.handCardId, existingHouseId: option.existingHouseId, absorbedLooseCardIds: option.absorbedLooseCardIds };
    case 'addToFixed':
      return {
        kind: 'addToFixed',
        handCardId: option.handCardId,
        floorCardIds: option.floorCardIds,
        existingHouseId: option.existingHouseId,
        absorbedLooseCardIds: option.absorbedLooseCardIds
      };
    case 'capture':
      return { kind: 'capture', handCardId: option.handCardId, targets: option.targets };
    case 'throw':
      return { kind: 'throw', handCardId: option.handCardId };
  }
}

/** Converts a discovered opening-decision option into the exact action `submitOpeningAction`
 * expects. Only build/capture/throw are reachable during the opening decision (Ingredient 4 never
 * discovers cement/break/mergeFix/addToFixed pre-opening, since no houses exist on a freshly
 * revealed floor yet). */
export function toOpeningAction(option: LegalOption): OpeningAction {
  if (option.kind === 'build') return { type: 'build', builderCardId: option.handCardId, floorCardIds: option.floorCardIds };
  if (option.kind === 'capture') return { type: 'capture', bidCardId: option.handCardId, targets: option.targets };
  if (option.kind === 'throw') return { type: 'throw', bidCardId: option.handCardId };
  throw new Error(`"${option.kind}" is not a reachable opening-decision option.`);
}

/** Every discovered option across a whole hand, flattened into one list — a convenience for
 * clients (bot, UI) that want to consider "every legal thing this player could do right now"
 * without walking the per-card Record themselves. */
export function flattenOptionsForHand(byCard: Record<string, LegalOption[]>): LegalOption[] {
  return Object.values(byCard).flat();
}

/**
 * Returns a copy of `game` with `playerId`'s hand truncated to just its first `visibleCount`
 * cards — for querying legal options as they'd genuinely look to a player who hasn't picked up
 * the rest of their hand yet (the 2-player opening-decision visibility rule: the bidder is dealt
 * their full hand up front, but has only looked at the first 4 before calling/opening).
 *
 * This exists because Ingredient 4's own option discovery (discoverOpeningOptionsForHand,
 * legalMoves.ts) legitimately checks the WHOLE hand for some legality conditions — e.g. a Build's
 * "retains" check, which asks whether the hand still holds another card of the target value after
 * playing this one. That check is correct engine behavior (it's real dealer-side bookkeeping, not
 * player knowledge), but it means a query against the player's true full hand can surface a build
 * option whose legality secretly depends on a card the player can't see yet — confusing, and not
 * what "you've only looked at 4 cards" should feel like. Truncating the hand BEFORE discovery,
 * rather than filtering the returned options afterward, makes every check inside discovery —
 * including "retains" — evaluate against only the cards actually visible, with no engine change
 * needed. A card here is a card there, all reachability strictly narrower.
 */
export function withOnlyVisibleHand(game: OrchestratedGame, playerId: string, visibleCount: number): OrchestratedGame {
  return {
    ...game,
    state: {
      ...game.state,
      players: game.state.players.map(p => (p.id === playerId ? { ...p, hand: p.hand.slice(0, visibleCount) } : p))
    }
  };
}
