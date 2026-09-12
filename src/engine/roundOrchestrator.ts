import type { Card, GameState, OpeningAction, Player, Team } from '../types';
import { createDeck, shuffleDeck } from './deck';
import {
  dealMainHands2Player,
  dealMainHands4Player,
  dealOpeningHands,
  revealFloor,
  submitBid as dealSubmitBid
} from './deal';
import { submitOpeningAction as applyOpeningAction } from './openingAction';
import { discoverLegalOptionsForHand } from './legalMoves';
import type { LegalOption } from './legalMoves';
import { executeMove, finalizeOpeningAndAdvance } from './moveExecution';
import type { NormalPlayMove } from './moveExecution';
import { completeRound as scoreCompletedRound } from './scoring';
import type { GameLengthConfig, RoundCompletionResult } from './scoring';

// ---------------------------------------------------------------------------
// Ingredient 8 — Round Orchestrator. Connects Ingredients 2–7 into one deterministic,
// player-driven round/game flow. This file contains NO rule logic of its own: every phase
// transition, legality check, and score computation is delegated to the existing frozen
// ingredient it belongs to. Ingredient 8 only sequences those calls and carries the small piece
// of session-level information (who deals, how long the game runs) that no existing GameState
// field represents — see OrchestratedGame below for why that's a new wrapper type rather than a
// change to the frozen GameState.
//
// Critical architectural rule (frozen for this ingredient): nothing here ever chooses a move on
// a player's behalf. discoverLegalMoves is a pure read; submitBid/submitOpeningAction/submitMove
// only ever apply a decision the caller already made. There is no loop that plays cards by itself.
// ---------------------------------------------------------------------------

/**
 * `dealerId` is not part of `GameState` — Ingredient 2's dealing functions have always taken it
 * as a caller-supplied parameter, never persisted it (confirmed by inspection: no field on
 * GameState represents it). Since `dealMainHands4Player`/`dealMainHands2Player` need the SAME
 * dealerId that started the round, and the eventual next-round transition needs to know who dealt
 * this round to determine who deals the next one, something has to carry it across the several
 * calls a round involves — that's what this wrapper is for. `gameLengthConfig` has the identical
 * problem (Ingredient 7 needs it at every `completeRound` call, and nothing in GameState
 * represents "how long is this game configured to run"). Neither is a change to any frozen type;
 * both are genuinely new information only Ingredient 8 needs to carry.
 */
export interface OrchestratedGame {
  state: GameState;
  dealerId: string;
  gameLengthConfig: GameLengthConfig;
}

function sideOf(state: GameState, playerId: string): string {
  if (state.mode === '2player') return playerId;
  const team = state.teams.find(t => t.playerIds.includes(playerId));
  if (!team) throw new Error(`Invalid GameState: no team entry contains player ${playerId} in 4-player mode.`);
  return team.id;
}

function dealMainHands(state: GameState, dealerId: string): GameState {
  return state.mode === '4player' ? dealMainHands4Player(state, dealerId) : dealMainHands2Player(state, dealerId);
}

// ---------------------------------------------------------------------------
// Start a round.
// ---------------------------------------------------------------------------

/**
 * Starts a brand-new game at round 1. Constructs the initial GameState — nothing else in the
 * codebase does this; every existing ingredient operates on a state that already exists — then
 * hands off to Ingredient 2's dealOpeningHands. `deck` may be supplied for deterministic tests;
 * it defaults to a fresh shuffle, matching dealOpeningHands' own expectation of a full 52-card
 * deck in any order (it does its own caller-eligibility reshuffle internally).
 */
export function startRound(params: {
  gameId: string;
  mode: GameState['mode'];
  players: { id: string; name: string }[];
  dealerId: string;
  gameLengthConfig: GameLengthConfig;
  teams?: Team[];
  scores?: Record<string, number>;
  deck?: Card[];
}): OrchestratedGame {
  const players: Player[] = params.players.map(p => ({ id: p.id, name: p.name, teamId: null, hand: [], reserve: [], captured: [] }));
  const state: GameState = {
    gameId: params.gameId,
    mode: params.mode,
    roundNumber: 1,
    players,
    teams: params.teams ?? [],
    floor: { loose: [], houses: [] },
    deck: params.deck ?? shuffleDeck(createDeck()),
    phase: 'dealing',
    currentPlayerIndex: 0,
    turnNumber: 0,
    bidValue: null,
    bidderId: null,
    sweepRecords: [],
    scores: params.scores ?? {},
    roundScores: {},
    history: []
  };
  return { state: dealOpeningHands(state, params.dealerId), dealerId: params.dealerId, gameLengthConfig: params.gameLengthConfig };
}

/**
 * Starts the next round of an ongoing game, once `completeRound` has reported the game is not
 * over. Carries `teams` and cumulative `scores` forward unchanged, resets every player's hand/
 * reserve/captured for the fresh round, and increments `roundNumber` — nothing else in the
 * codebase does this either. The next dealer is resolved from `result.nextDealerSide` (the
 * trailing side deals — frozen rule): in 2-player mode the side already IS the player id; in
 * 4-player mode any player on that team is a valid dealerId, since dealing is entirely
 * code-driven and no rule specifies which specific seat on a team deals (confirmed with the
 * Product Owner — not an unresolved question, just not a per-seat concept in this game). On a
 * tied round, the current dealer deals again — not a new rule, just "nothing changes" in the
 * absence of a specified tie-breaking dealer rule.
 */
export function startNextRound(previous: OrchestratedGame, result: RoundCompletionResult): OrchestratedGame {
  if (result.gameOver) {
    throw new Error('Cannot start another round: the game has already ended.');
  }
  const dealerId = resolveNextDealerId(previous, result);
  const players = previous.state.players.map(p => ({ ...p, hand: [], reserve: [], captured: [] }));
  const state: GameState = {
    ...previous.state,
    players,
    floor: { loose: [], houses: [] },
    deck: shuffleDeck(createDeck()),
    phase: 'dealing',
    currentPlayerIndex: 0,
    turnNumber: 0,
    bidValue: null,
    bidderId: null,
    sweepRecords: [],
    scores: result.state.scores,
    roundScores: {},
    history: [],
    roundNumber: previous.state.roundNumber + 1
  };
  return { state: dealOpeningHands(state, dealerId), dealerId, gameLengthConfig: previous.gameLengthConfig };
}

function resolveNextDealerId(previous: OrchestratedGame, result: RoundCompletionResult): string {
  if ('tied' in result.nextDealerSide) return previous.dealerId;
  const side = result.nextDealerSide.side;
  const player = previous.state.players.find(p => sideOf(previous.state, p.id) === side);
  if (!player) throw new Error(`No player found on side "${side}" to deal the next round.`);
  return player.id;
}

// ---------------------------------------------------------------------------
// Bid and floor reveal. Revealing the floor is not itself a player decision (it's an automatic
// consequence of a valid bid, per Ingredient 2's own contract), so it's bundled into this one
// call rather than exposed as a separate step — this doesn't hide a decision, since there is no
// decision to hide.
// ---------------------------------------------------------------------------

export function submitBid(game: OrchestratedGame, playerId: string, value: number): OrchestratedGame {
  const bid = dealSubmitBid(game.state, playerId, value);
  return { ...game, state: revealFloor(bid) };
}

// ---------------------------------------------------------------------------
// Opening action. The bidder supplies the action; Ingredient 3 is the sole referee for it.
// Dealing everyone else's main hands and advancing to the first main-play turn are, like floor
// reveal, automatic consequences with no player decision of their own, so they're bundled here
// too. dealMainHands* MUST run before finalizeOpeningAndAdvance — turn advancement needs every
// player's hand already dealt to find the next player to act (see the Ingredient 2 phase-
// ownership correction made during this ingredient's development: dealMainHands4Player/2Player
// used to also claim the 'opening' -> 'playing' transition, which conflicted with
// finalizeOpeningAndAdvance claiming the same transition — fixed by leaving that transition solely
// to finalizeOpeningAndAdvance).
// ---------------------------------------------------------------------------

export function submitOpeningAction(game: OrchestratedGame, playerId: string, action: OpeningAction): OrchestratedGame {
  const afterAction = applyOpeningAction(game.state, playerId, action);
  const afterDeal = dealMainHands(afterAction, game.dealerId);
  const afterAdvance = finalizeOpeningAndAdvance(afterDeal, playerId, action.type === 'capture');
  return { ...game, state: afterAdvance };
}

// ---------------------------------------------------------------------------
// Main play. discoverLegalMoves is a pure read — it decides nothing and mutates nothing.
// submitMove only ever applies a move the caller already chose from that list. executeMove
// (Ingredient 5) already calls Ingredient 6's advanceAfterMove internally, so this is the ONE
// call needed per move — a second, separate "advance the turn" step here would double-advance
// turnNumber, which is exactly what Ingredient 6 was built to prevent.
// ---------------------------------------------------------------------------

export function discoverLegalMoves(game: OrchestratedGame, playerId: string): Record<string, LegalOption[]> {
  return discoverLegalOptionsForHand(game.state, playerId);
}

export function submitMove(game: OrchestratedGame, playerId: string, move: NormalPlayMove): OrchestratedGame {
  return { ...game, state: executeMove(game.state, playerId, move) };
}

// ---------------------------------------------------------------------------
// Round / game completion. Ingredient 6 has already brought phase to 'roundEnd' (and already
// moved any leftover loose floor cards to the last capturer) by the time this is meaningful to
// call — completeRound (Ingredient 7) enforces that precondition itself, so no duplicate check is
// needed here.
// ---------------------------------------------------------------------------

export function isRoundComplete(game: OrchestratedGame): boolean {
  return game.state.phase === 'roundEnd';
}

export function completeRound(game: OrchestratedGame): RoundCompletionResult {
  return scoreCompletedRound(game.state, game.gameLengthConfig);
}

export type { GameLengthConfig, RoundCompletionResult } from './scoring';
export type { LegalOption } from './legalMoves';
export type { NormalPlayMove } from './moveExecution';
