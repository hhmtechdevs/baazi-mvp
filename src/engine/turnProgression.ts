import type { GameEvent, GameState } from '../types';

// ---------------------------------------------------------------------------
// Ingredient 6 — turn & hand progression. This is the SOLE place turn/phase progression is
// decided: moveExecution.ts's executeMove/finalizeOpeningAndAdvance (Ingredient 5) delegate to
// the two entry points below rather than computing progression themselves, so there is exactly
// one authoritative path and no risk of double-advancing turnNumber or currentPlayerIndex.
//
// Array order IS seating/turn order (counter-clockwise) — this is not a new assumption introduced
// here, it is the existing convention already established by Ingredient 2: dealOpeningHands
// computes the bidder as `players[(dealerIndex + 1) % players.length]`, i.e. "next in array
// order" already means "next seat counter-clockwise" throughout the frozen deal logic. Ingredient
// 6 relies on that same convention rather than introducing a second one.
// ---------------------------------------------------------------------------

/**
 * The next player, in seating order, whose hand is non-empty — skipping any empty-handed players
 * along the way. This is the single mechanism behind three frozen rules at once: normal turn
 * rotation (nobody is skipped when everyone has cards), "a player with an empty hand simply has
 * no further cards to play" (4-player), and "a player whose first hand is empty does not act
 * again until their reserve activates" (2-player phase 1) — all three are the same rule viewed
 * from different hand-size situations, not three separate mechanisms.
 */
function findNextPlayerWithCards(state: GameState, fromIndex: number): number {
  const n = state.players.length;
  for (let step = 1; step <= n; step++) {
    const idx = (fromIndex + step) % n;
    if (state.players[idx].hand.length > 0) return idx;
  }
  throw new Error(
    'findNextPlayerWithCards found no player with cards — this indicates advanceTurnAndPhase failed to detect ' +
    'end-of-play before calling it, which would be a logic error in Ingredient 6, not a legitimate game state.'
  );
}

/**
 * Activates every player's reserve as their new active hand, simultaneously. Only ever called
 * once both players' first hands are confirmed empty (see advanceTurnAndPhase) — never per-player,
 * per the frozen correction: "do NOT switch each player to their reserve individually."
 */
function activateAllReserves(state: GameState): GameState {
  return {
    ...state,
    players: state.players.map(p => (p.reserve.length > 0 ? { ...p, hand: p.reserve, reserve: [] } : p))
  };
}

/**
 * Records that `playerId` completed a capture, using the existing `history`/`GameEvent`
 * machinery (typed since Ingredient 2's GameState, never previously populated by any execution
 * code) rather than adding a new GameState field. `timestamp` uses `turnNumber` — the state's own
 * existing monotonic sequence counter — rather than wall-clock time, keeping this deterministic
 * and consistent with how the rest of the engine already treats time as "which turn," not "when."
 */
function recordCaptureEvent(state: GameState, playerId: string): GameState {
  const event: GameEvent = { type: 'capture', playerId, payload: {}, timestamp: state.turnNumber };
  return { ...state, history: [...state.history, event] };
}

/**
 * The most recently recorded capturer, derived from `history` rather than tracked as a separate
 * field — `history` already exists and is exactly sufficient for this, so no new GameState field
 * was needed (see the Ingredient 6 report for why this was checked rather than assumed).
 */
function lastCapturingPlayerId(state: GameState): string | null {
  for (let i = state.history.length - 1; i >= 0; i--) {
    if (state.history[i].type === 'capture') return state.history[i].playerId;
  }
  return null;
}

/**
 * Ends play: remaining loose floor cards go to whoever captured last (not whoever played last —
 * these can differ, e.g. the last few turns were throws/builds after the final capture). Houses
 * are left untouched — per the frozen scope, they "should already have been resolved through
 * normal play"; Ingredient 6 does not invent handling for a house that somehow remains
 * uncaptured (see the report's "remaining concerns" for why this is flagged rather than guessed
 * at). If no capture ever occurred this round (no LegalOption reached one, or none was recorded),
 * the loose cards are left exactly where they are — not scored, not assigned, not discarded, per
 * the same "do not guess" discipline: there is no frozen rule covering this degenerate case.
 */
function transitionToRoundEnd(state: GameState): GameState {
  const capturer = lastCapturingPlayerId(state);
  const leftover = state.floor.loose;
  if (!capturer || leftover.length === 0) {
    return { ...state, phase: 'roundEnd' };
  }
  const players = state.players.map(p => (p.id === capturer ? { ...p, captured: [...p.captured, ...leftover] } : p));
  return { ...state, players, floor: { ...state.floor, loose: [] }, phase: 'roundEnd' };
}

/**
 * The shared core: given the state immediately after a move (or the opening action) has already
 * been applied, with `currentPlayerIndex` still pointing at the player who just acted, decide
 * what happens next — end of play, the 2-player synchronized reserve transition, or ordinary
 * rotation to the next player with cards. `turnNumber` is incremented exactly once here, since
 * this function is called exactly once per completed action.
 */
function advanceTurnAndPhase(state: GameState): GameState {
  const turnNumber = state.turnNumber + 1;

  if (state.mode === '4player') {
    if (state.players.every(p => p.hand.length === 0)) {
      return transitionToRoundEnd({ ...state, turnNumber });
    }
    return { ...state, turnNumber, currentPlayerIndex: findNextPlayerWithCards(state, state.currentPlayerIndex) };
  }

  // 2-player
  if (state.players.every(p => p.hand.length === 0)) {
    const hasReserveLeft = state.players.some(p => p.reserve.length > 0);
    if (!hasReserveLeft) {
      return transitionToRoundEnd({ ...state, turnNumber });
    }
    const activated = activateAllReserves(state);
    return { ...activated, turnNumber, currentPlayerIndex: findNextPlayerWithCards(activated, state.currentPlayerIndex) };
  }
  return { ...state, turnNumber, currentPlayerIndex: findNextPlayerWithCards(state, state.currentPlayerIndex) };
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Consumes a successfully completed normal-play move's result and handles everything about what
 * happens next: recording who captured (for eventual end-of-play floor attribution), finding the
 * next player to act, the 2-player synchronized reserve transition, and end-of-play detection.
 * `wasCapture` is supplied by the caller (moveExecution.ts already knows the move's kind) rather
 * than re-derived here, so this never duplicates Ingredient 4/5's capture-discovery logic.
 */
export function advanceAfterMove(state: GameState, actingPlayerId: string, wasCapture: boolean): GameState {
  const withEvent = wasCapture ? recordCaptureEvent(state, actingPlayerId) : state;
  return advanceTurnAndPhase(withEvent);
}

/**
 * Bridges the opening action (Ingredient 3) into normal play. The next player is derived
 * explicitly from `state.bidderId` — not from whatever `state.currentPlayerIndex` happened to
 * already be — because nothing in Ingredient 2/3 ever sets `currentPlayerIndex` to the bidder
 * before the opening move; relying on it would have been an unverified assumption, not a fact
 * established by the existing architecture. See the Ingredient 6 report for this finding.
 */
export function advanceAfterOpeningAction(state: GameState, wasCapture: boolean): GameState {
  if (!state.bidderId) throw new Error('No bidder is set.');
  const bidderIndex = state.players.findIndex(p => p.id === state.bidderId);
  if (bidderIndex === -1) throw new Error(`Bidder ${state.bidderId} is not among the players.`);
  const withEvent = wasCapture ? recordCaptureEvent(state, state.bidderId) : state;
  return advanceTurnAndPhase({ ...withEvent, currentPlayerIndex: bidderIndex });
}
