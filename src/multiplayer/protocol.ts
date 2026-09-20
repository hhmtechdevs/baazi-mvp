import type { OrchestratedGame, RoundCompletionResult } from '../engine/roundOrchestrator';

/**
 * What one Baazi table looks like when it is written down.
 *
 * The whole thing lives in a single jsonb column on the existing `baazi_rooms` row, so no schema
 * change was needed to add multiplayer — see store.ts for why that column is also what makes
 * compare-and-swap possible.
 *
 * Nothing in this file performs I/O or decides a rule. It is the shape of the table plus the small
 * set of pure decisions about who may do what, which is exactly the part that has to move to a
 * server when the authority moves there.
 */

/** Bumped if the stored shape ever changes incompatibly, so an old row is ignored rather than
 * misread. The Guacamole-era rows in this table have no `v` at all and are skipped by that rule. */
export const ENVELOPE_VERSION = 4;

/** Engine seat ids. The order matters and is not cosmetic: the 4-player deal pairs seats 0+2 and
 * 1+3, so listing them this way puts the two humans on one team and the two AI players on the
 * other, with your partner sitting opposite you. */
export const SEAT_ORDER = ['you', 'left', 'partner', 'right'] as const;
export type SeatId = (typeof SEAT_ORDER)[number];

export const HOST_SEAT: SeatId = 'you';
export const GUEST_SEAT: SeatId = 'partner';

/**
 * The order open seats are handed out — which is NOT the engine's seat order.
 *
 * The engine pairs seats 0+2 and 1+3, so filling in engine order would put the second person to
 * arrive on the OPPOSING team. Seating them opposite the host instead means two people are always
 * partners, three are two against one, and four are two against two — the arrangement people
 * expect at every table size, rather than one that depends on who clicked first.
 */
const JOIN_ORDER: SeatId[] = ['you', 'partner', 'left', 'right'];

export interface SeatRecord {
  seat: SeatId;
  name: string;
  kind: 'human' | 'ai';
  /** Which browser session controls this seat. Null means the seat is still open. AI seats are
   * never controlled by a session — that is what stops a client claiming one. */
  sessionId: string | null;
}

/** A guest asking to play. It is a REQUEST, not a move: only the host applies it, and only after
 * the engine agrees it is legal. */
export interface ActionRequest {
  id: string;
  sessionId: string;
  seat: SeatId;
  /**
   * The GAME revision the player was looking at when they decided. An action aimed at a game that
   * has already moved on is refused rather than applied to a position the player never saw.
   *
   * Deliberately not the envelope's `revision`: that counts every write, including the write that
   * attaches this very request, so checking against it would reject every request the moment it
   * was filed. These are two different questions — "has anyone written?" and "has the game
   * changed?" — and conflating them was a real bug, caught only by two browsers actually playing.
   */
  forGameRevision: number;
  kind: 'bid' | 'openingAction' | 'move';
  payload: unknown;
}

export type TableStatus = 'waiting' | 'ready' | 'playing' | 'finished';

export interface TableEnvelope {
  v: number;
  /** Compare-and-swap token for WRITES. Every write increments it, and every write is conditional
   * on the value it read — see store.ts. */
  revision: number;
  /**
   * When the current turn began, as epoch milliseconds — written by the authority every time the
   * game moves.
   *
   * It lives in the envelope rather than in each browser for two reasons: both players have to see
   * the same clock (a local timer would drift, and would show two different countdowns), and a
   * refresh must not hand you a fresh ten seconds. It is also what lets the host enforce the limit
   * for a player whose browser has gone away.
   */
  turnStartedAt: number;
  /** How many times the GAME has actually changed. Only moves it when the engine produces a new
   * state, so a player's view of the position can be checked for staleness independently of
   * unrelated writes to the row. */
  gameRevision: number;
  status: TableStatus;
  code: string;
  /** The session that runs the engine for this table. */
  hostSessionId: string;
  seats: SeatRecord[];
  game: OrchestratedGame | null;
  /** The score for the round that just finished, computed once by the authority and shown to
   * everybody — so both players read the same numbers rather than each totting them up. */
  lastResult: RoundCompletionResult | null;
  /**
   * What each side scored in the last round that was played, kept for the tally at the top of the
   * table. `lastResult` cannot serve this: it is cleared the moment the next round is dealt,
   * because it is also what puts the score card on screen. This outlives that, and lives in the
   * envelope rather than in each browser so everyone at the table reads the same two numbers and a
   * refresh doesn't lose them.
   *
   * Optional, and read as "no round finished yet" when absent: tables opened before this existed
   * are still perfectly valid envelopes, and bumping the version would have thrown away games that
   * were in progress.
   */
  lastRoundScores?: Record<string, number> | null;
  /** The guest's mailbox — at most one outstanding request. */
  request: ActionRequest | null;
  /** So a request that arrives twice (retry, double-tap, reconnect) is applied once. */
  lastAppliedRequestId: string | null;
  /** Why the last request was turned down, for the player who made it. Cleared on the next accept. */
  lastRejection: { requestId: string; reason: string } | null;
}

// ---------------------------------------------------------------------------
// Room codes
// ---------------------------------------------------------------------------

/** No 0/O, no 1/I/L — these get read aloud over the phone and typed by someone who wasn't looking. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 4;

export function generateCode(random: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  }
  return code;
}

/** Accepts what a person actually types: lower case, stray spaces, and the characters the alphabet
 * deliberately avoids, mapped to what they obviously meant. Returns null if it still isn't a code. */
export function normaliseCode(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/0/g, 'O')
    .replace(/[1IL]/g, 'J')
    .replace(/O/g, 'Q');
  if (cleaned.length !== CODE_LENGTH) return null;
  if (![...cleaned].every(ch => CODE_ALPHABET.includes(ch))) return null;
  return cleaned;
}

// ---------------------------------------------------------------------------
// Building a table
// ---------------------------------------------------------------------------

/**
 * What a seat is called when nobody has given it a name.
 *
 * Deliberately numbers rather than positions. "Left" and "Right" were fine while those seats were
 * played by the computer, but they are relative words stored as absolute names: the player in the
 * `left` seat is on the host's left and on the opposite player's RIGHT. With four people at the
 * table that is simply wrong from two of the four chairs — the same class of mistake as storing
 * "You" as a name.
 *
 * A number is true from every seat. Anyone who types a name replaces it, which is the intended
 * path; this is only what you get when nobody bothers.
 */
export const SEAT_NAMES: Record<SeatId, string> = {
  you: 'Player 1',
  left: 'Player 2',
  partner: 'Player 3',
  right: 'Player 4'
};

export function createEnvelope(code: string, hostSessionId: string, hostName?: string): TableEnvelope {
  return {
    v: ENVELOPE_VERSION,
    revision: 1,
    gameRevision: 0,
    turnStartedAt: 0,
    status: 'waiting',
    code,
    hostSessionId,
    // All four seats start open to people. Whoever hasn't turned up by the time the host starts
    // becomes a computer seat (see host.startTable) — so one flow covers two players, three, or a
    // full table, instead of the seating being decided before anyone has arrived.
    seats: SEAT_ORDER.map(seat => ({
      seat,
      name: seat === HOST_SEAT ? hostName?.trim() || SEAT_NAMES[seat] : SEAT_NAMES[seat],
      kind: 'human',
      sessionId: seat === HOST_SEAT ? hostSessionId : null
    })),
    game: null,
    lastResult: null,
    lastRoundScores: null,
    request: null,
    lastAppliedRequestId: null,
    lastRejection: null
  };
}

export function isUsableEnvelope(value: unknown): value is TableEnvelope {
  const e = value as TableEnvelope | null;
  return !!e && e.v === ENVELOPE_VERSION && Array.isArray(e.seats) && typeof e.revision === 'number';
}

export function seatOf(envelope: TableEnvelope, sessionId: string): SeatId | null {
  return envelope.seats.find(s => s.sessionId === sessionId)?.seat ?? null;
}

export function seatRecord(envelope: TableEnvelope, seat: SeatId): SeatRecord | undefined {
  return envelope.seats.find(s => s.seat === seat);
}

// ---------------------------------------------------------------------------
// Claiming a seat
// ---------------------------------------------------------------------------

export type JoinResult =
  | { ok: true; envelope: TableEnvelope; seat: SeatId; rejoined: boolean }
  | { ok: false; reason: string };

/**
 * Sitting down at a table that already exists.
 *
 * A browser never says which seat it is — it asks, and this decides. Coming back with a session
 * that already holds a seat returns that same seat and changes nothing, which is what makes a
 * refresh or a reopened browser land back where it was instead of taking a second chair.
 */
export function claimSeat(envelope: TableEnvelope, sessionId: string, name?: string): JoinResult {
  const existing = seatOf(envelope, sessionId);
  if (existing) return { ok: true, envelope, seat: existing, rejoined: true };

  const open = JOIN_ORDER.map(seat => seatRecord(envelope, seat)).find(
    s => s && s.kind === 'human' && s.sessionId === null
  );
  if (!open) return { ok: false, reason: 'That table is full.' };

  const seats = envelope.seats.map(s =>
    s.seat === open.seat ? { ...s, sessionId, name: name?.trim() || s.name } : s
  );
  // 'ready' tells the host to deal, and is only reached when no seat is still waiting on a person.
  // Below that, the host decides when to start — otherwise a four-handed table would deal itself
  // the moment the second person sat down. The host, not the joiner, always starts the round: one
  // writer owns every piece of game state.
  const stillOpen = seats.some(s => s.kind === 'human' && s.sessionId === null);
  return {
    ok: true,
    seat: open.seat,
    rejoined: false,
    envelope: {
      ...envelope,
      seats,
      status: stillOpen ? envelope.status : 'ready',
      revision: envelope.revision + 1
    }
  };
}

/** Seats still waiting on a person to sit down. */
export function openHumanSeats(envelope: TableEnvelope): SeatRecord[] {
  return envelope.seats.filter(s => s.kind === 'human' && s.sessionId === null);
}

/** Everyone who has actually sat down. */
export function seatedPeople(envelope: TableEnvelope): SeatRecord[] {
  return envelope.seats.filter(s => s.sessionId !== null);
}

// ---------------------------------------------------------------------------
// Is this request allowed to be considered at all?
// ---------------------------------------------------------------------------

export type Authorisation = { ok: true } | { ok: false; reason: string };

/**
 * Everything that can be decided about a request WITHOUT consulting the rules: is this session in
 * that seat, is it that seat's turn, is the table still where the player thought it was, and has
 * this request already been dealt with.
 *
 * Legality of the move itself is never decided here — that is the engine's job, and asking it is
 * the host's next step (see host.ts). Keeping the two apart is what stops a second, divergent copy
 * of the rules growing inside the multiplayer layer.
 */
export function authoriseRequest(envelope: TableEnvelope, request: ActionRequest): Authorisation {
  if (envelope.lastAppliedRequestId === request.id) {
    return { ok: false, reason: 'That action was already played.' };
  }
  if (request.forGameRevision !== envelope.gameRevision) {
    return { ok: false, reason: 'The table moved on — try again.' };
  }

  const seat = envelope.seats.find(s => s.seat === request.seat);
  if (!seat) return { ok: false, reason: 'No such seat at this table.' };
  if (seat.kind !== 'human') return { ok: false, reason: 'That seat is not played by a person.' };
  if (seat.sessionId !== request.sessionId) return { ok: false, reason: 'That is not your seat.' };

  const game = envelope.game;
  if (!game) return { ok: false, reason: 'The round has not been dealt yet.' };

  const expected = expectedActor(envelope);
  if (expected !== request.seat) return { ok: false, reason: "It is not that player's turn." };

  return { ok: true };
}

/**
 * Which seat the table is waiting on, from the engine's own state — the caller during the call and
 * the opening play, the player to move during normal play.
 */
export function expectedActor(envelope: TableEnvelope): SeatId | null {
  const state = envelope.game?.state;
  if (!state) return null;
  if (state.phase === 'bidding' || state.phase === 'revealing') return (state.bidderId as SeatId) ?? null;
  if (state.phase === 'playing') return (state.players[state.currentPlayerIndex]?.id as SeatId) ?? null;
  return null;
}

/**
 * How long a seat gets before the authority plays for it.
 *
 * A person gets thirty seconds; a computer seat gets five seconds, which is the pause that was
 * already there to make its play watchable rather than instant. Same mechanism, two speeds.
 *
 * A testing parameter, not a game rule: it went 20 s -> 60 s after the first family game, and is
 * now 30 s for the current round of test play. This stays the one place the value lives.
 */
export const HUMAN_TURN_MS = 30_000;
export const AI_TURN_MS = 5_000;

export function turnLimitMs(envelope: TableEnvelope, seat: SeatId): number {
  return seatRecord(envelope, seat)?.kind === 'ai' ? AI_TURN_MS : HUMAN_TURN_MS;
}

/** Milliseconds left on the current turn, floored at zero. */
export function turnRemainingMs(envelope: TableEnvelope, now: number): number {
  const actor = expectedActor(envelope);
  if (!actor || !envelope.turnStartedAt) return 0;
  return Math.max(0, envelope.turnStartedAt + turnLimitMs(envelope, actor) - now);
}

/** True when the table is waiting on a seat nobody is sitting in — i.e. the host should play it. */
export function awaitingAi(envelope: TableEnvelope): SeatId | null {
  const actor = expectedActor(envelope);
  if (!actor) return null;
  return seatRecord(envelope, actor)?.kind === 'ai' ? actor : null;
}
