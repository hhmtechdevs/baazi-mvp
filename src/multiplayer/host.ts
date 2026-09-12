import { completeRound, startNextRound, startRound, submitBid, submitMove, submitOpeningAction } from '../engine/roundOrchestrator';
import { botChooseBid, botChooseMove, botChooseOpeningAction } from '../botStrategy';
import type { OpeningAction } from '../types';
import type { NormalPlayMove } from '../engine/moveExecution';
import {
  authoriseRequest,
  expectedActor,
  seatRecord,
  turnLimitMs,
  SEAT_ORDER,
  SEAT_NAMES
} from './protocol';
import type { ActionRequest, SeatId, TableEnvelope } from './protocol';

/**
 * The authority.
 *
 * Exactly one party advances a table, and this is what it runs. Everything here is a PURE function
 * of an envelope: hand it the table as written down and it hands back the table as it should now
 * be, or null if there is nothing to do. It performs no I/O, holds no state, and knows nothing
 * about React or Supabase.
 *
 * That is deliberate, and it is the whole design. Today the host's browser calls these; moving the
 * authority onto a server means calling the same two functions from a request handler instead. The
 * seam is the transport, not the logic — so the rules never get a second implementation, which is
 * the failure this layer exists to avoid.
 *
 * Legality is never decided here either. Every state transition below goes through the frozen
 * orchestrator, and an illegal move is discovered by the engine throwing, not by this file
 * re-deciding what Seep allows.
 */

/** A seat nobody is sitting in is played by the same strategy module Practice uses. */
function isAiSeat(envelope: TableEnvelope, seat: SeatId): boolean {
  return envelope.seats.find(s => s.seat === seat)?.kind === 'ai';
}

/**
 * Every authoritative write advances `revision`, which is what makes concurrent writes safe.
 * `gameRevision` advances only when the position itself changed — so a write that merely files or
 * clears a request doesn't invalidate a decision another player has already made.
 */
function bump(
  envelope: TableEnvelope,
  patch: Partial<TableEnvelope>,
  gameMoved = false,
  now = Date.now()
): TableEnvelope {
  return {
    ...envelope,
    ...patch,
    revision: envelope.revision + 1,
    gameRevision: envelope.gameRevision + (gameMoved ? 1 : 0),
    // A new turn starts exactly when the last one ended, and only then — so the clock everybody
    // sees is the same clock, and a refresh doesn't quietly hand anyone a fresh ten seconds.
    turnStartedAt: gameMoved ? now : envelope.turnStartedAt
  };
}

// ---------------------------------------------------------------------------
// Dealing the first round
// ---------------------------------------------------------------------------

/**
 * Once the second person has sat down, deal. The host does this rather than the joiner, so that
 * every byte of game state has exactly one author.
 */
export function startTable(envelope: TableEnvelope, dealerSeat: SeatId = 'you', now: number = Date.now()): TableEnvelope {
  const game = startRound({
    gameId: `baazi-${envelope.code}-${Date.now()}`,
    mode: '4player',
    players: SEAT_ORDER.map(seat => ({
      id: seat,
      name: envelope.seats.find(s => s.seat === seat)?.name ?? SEAT_NAMES[seat]
    })),
    dealerId: dealerSeat,
    gameLengthConfig: { type: 'leadTarget', points: 100 }
  });
  return bump(envelope, { status: 'playing', game }, true, now);
}

// ---------------------------------------------------------------------------
// Applying a request
// ---------------------------------------------------------------------------

export type ApplyResult =
  | { applied: true; envelope: TableEnvelope }
  | { applied: false; envelope: TableEnvelope; reason: string };

/**
 * A player asked to do something. Decide whether they may, then ask the engine whether it is legal,
 * then let the engine produce the result.
 *
 * Both refusals are recorded the same way — the request is cleared and the reason is written where
 * the player who made it can see it — so a rejected action can never leave the table half-changed.
 */
export function applyRequest(envelope: TableEnvelope, request: ActionRequest, now: number = Date.now()): ApplyResult {
  const allowed = authoriseRequest(envelope, request);
  if (!allowed.ok) {
    return {
      applied: false,
      reason: allowed.reason,
      envelope: bump(envelope, { request: null, lastRejection: { requestId: request.id, reason: allowed.reason } })
    };
  }

  const game = envelope.game!;
  try {
    const next = runAction(game, request.seat, request.kind, request.payload);
    return {
      applied: true,
      envelope: bump(
        envelope,
        { game: next, request: null, lastAppliedRequestId: request.id, lastRejection: null },
        true,
        now
      )
    };
  } catch (error) {
    // The engine refused it. This is the authoritative answer on legality, and the only one.
    const reason = error instanceof Error ? error.message : 'That move is not legal.';
    return {
      applied: false,
      reason,
      envelope: bump(envelope, { request: null, lastRejection: { requestId: request.id, reason } })
    };
  }
}

function runAction(
  game: NonNullable<TableEnvelope['game']>,
  seat: SeatId,
  kind: ActionRequest['kind'],
  payload: unknown
) {
  if (kind === 'bid') return submitBid(game, seat, payload as number);
  if (kind === 'openingAction') return submitOpeningAction(game, seat, payload as OpeningAction);
  return submitMove(game, seat, payload as NormalPlayMove);
}

// ---------------------------------------------------------------------------
// The one thing the host does on a tick
// ---------------------------------------------------------------------------

export type HostStep =
  | { kind: 'deal'; envelope: TableEnvelope }
  | { kind: 'score'; envelope: TableEnvelope }
  | { kind: 'request'; envelope: TableEnvelope; applied: boolean; reason?: string }
  /** A seat's time ran out and the authority played for it. `onBehalfOfPerson` is true when that
   * seat belongs to a human — the deliberate, Product-Owner-approved behaviour, and the one case
   * where a move is made by someone other than the player sitting there. */
  | { kind: 'play'; envelope: TableEnvelope; seat: SeatId; onBehalfOfPerson: boolean }
  | null;

/**
 * The round has run out of cards. Score it — once, by the authority — so both players are shown
 * the same numbers rather than each computing their own.
 */
export function scoreRound(envelope: TableEnvelope, now: number = Date.now()): TableEnvelope {
  const result = completeRound(envelope.game!);
  return bump(envelope, {
    game: { ...envelope.game!, state: result.state },
    lastResult: result,
    status: result.gameOver ? 'finished' : 'playing'
  }, false, now);
}

/**
 * Deal again after the scores have been read. Host-only and deliberate: nobody wants the next hand
 * landing on top of a score they were still looking at.
 */
export function dealNextRound(envelope: TableEnvelope, now: number = Date.now()): TableEnvelope {
  const result = envelope.lastResult;
  if (!result) throw new Error('There is no finished round to deal on from.');
  if (result.gameOver) throw new Error('The game is over.');
  return bump(envelope, { game: startNextRound(envelope.game!, result), lastResult: null }, true, now);
}

/**
 * Given the table as it stands and the time it is now, what should the authority do next? One step
 * at a time, in priority order, so a tick can never produce two changes at once and every change
 * gets its own revision.
 *
 * Time is a PARAMETER, not something read from a clock in here, so this stays a pure function of
 * (table, now) — which is what lets it be tested exactly and what lets it move to a server later.
 */
export function nextHostStep(envelope: TableEnvelope, now: number = Date.now()): HostStep {
  if (envelope.status === 'ready' && !envelope.game) {
    return { kind: 'deal', envelope: startTable(envelope, 'you', now) };
  }
  if (envelope.status !== 'playing' || !envelope.game) return null;

  // Scoring comes before anything else once the cards run out: there is nothing left to play, and
  // both screens are waiting to be told what the round was worth.
  if (envelope.game.state.phase === 'roundEnd' && !envelope.lastResult) {
    return { kind: 'score', envelope: scoreRound(envelope, now) };
  }

  if (envelope.request) {
    const result = applyRequest(envelope, envelope.request, now);
    return {
      kind: 'request',
      envelope: result.envelope,
      applied: result.applied,
      reason: result.applied ? undefined : result.reason
    };
  }

  // One rule, two speeds. A seat gets its allotted time and then the authority plays for it: five
  // seconds for a computer seat, which is the pause that always made its play watchable, and ten
  // for a person. Running the two through the same path is what keeps the countdown on screen
  // honest — the ring empties exactly when the move lands.
  const actor = expectedActor(envelope);
  if (!actor) return null;
  if (now - envelope.turnStartedAt < turnLimitMs(envelope, actor)) return null;

  return {
    kind: 'play',
    seat: actor,
    onBehalfOfPerson: seatRecord(envelope, actor)?.kind === 'human',
    envelope: playTurnFor(envelope, actor, now)
  };
}

/**
 * Take a seat's turn with the strategy module, through the engine.
 *
 * The strategy has always been seat-agnostic — it takes (game, playerId) — so the same code plays a
 * computer seat and stands in for a person whose time ran out. There is no separate "auto-play"
 * implementation, and no second opinion about what a good move is.
 */
export function playTurnFor(envelope: TableEnvelope, seat: SeatId, now: number = Date.now()): TableEnvelope {
  const game = envelope.game!;
  if (expectedActor(envelope) !== seat) throw new Error(`It is not ${seat}'s turn.`);

  const phase = game.state.phase;
  if (phase === 'bidding') return bump(envelope, { game: submitBid(game, seat, botChooseBid(game, seat)) }, true, now);
  if (phase === 'revealing') {
    return bump(envelope, { game: submitOpeningAction(game, seat, botChooseOpeningAction(game, seat)) }, true, now);
  }
  return bump(envelope, { game: submitMove(game, seat, botChooseMove(game, seat)) }, true, now);
}

/**
 * A computer seat's turn, decided once by the authority and written once — never worked out
 * separately inside each watching browser, which would let two people see two different games.
 * Refuses a seat somebody is actually sitting in; timing a person out goes through nextHostStep,
 * which is the only place that decision is allowed to be made.
 */
export function playAiTurn(envelope: TableEnvelope, seat: SeatId, now: number = Date.now()): TableEnvelope {
  if (!isAiSeat(envelope, seat)) throw new Error(`Seat ${seat} is not played by the computer.`);
  return playTurnFor(envelope, seat, now);
}
