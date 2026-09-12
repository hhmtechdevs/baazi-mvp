import type { GameState } from '../types';

/**
 * Where everybody is sitting.
 *
 * The engine knows a players ARRAY and a turn order; it has no concept of a seat, because seating
 * is not a rule. This module turns that array into positions around a physical surface, which is
 * the only thing the table layout needs from it.
 *
 * Display only — nothing here decides anything about the game.
 */

export type SeatPosition = 'south' | 'west' | 'north' | 'east';

/** Clockwise from the near edge. Turn order in the engine is simply the next index, so walking the
 * players array from your own seat clockwise puts the player who acts after you on your left —
 * which is also where the 4-player deal's default partnership (seats 0+2 / 1+3) puts your partner
 * directly opposite you. */
const CLOCKWISE: SeatPosition[] = ['south', 'west', 'north', 'east'];

/** Two players face each other across the blanket; nobody sits at the sides. */
const HEAD_TO_HEAD: SeatPosition[] = ['south', 'north'];

export interface Seat {
  playerId: string;
  name: string;
  position: SeatPosition;
  isYou: boolean;
  handCount: number;
  isTurn: boolean;
}

/**
 * Whose move it is — the one seat the table is waiting on.
 *
 * Covers the call and the opening play as well as ordinary turns: from where you're sitting those
 * are all "they're the one doing something", and the seat has to look awake through all of them
 * rather than going flat for the first stretch of every round.
 */
export function actingPlayerId(state: GameState): string | undefined {
  if (state.phase === 'bidding' || state.phase === 'revealing') return state.bidderId ?? undefined;
  if (state.phase === 'playing') return state.players[state.currentPlayerIndex]?.id;
  return undefined;
}

export function seatsAround(state: GameState, humanId: string): Seat[] {
  const count = state.players.length;
  const positions = count === 2 ? HEAD_TO_HEAD : CLOCKWISE;
  const youIndex = Math.max(0, state.players.findIndex(p => p.id === humanId));
  const acting = actingPlayerId(state);

  return state.players.map((player, i) => ({
    playerId: player.id,
    name: player.name,
    position: positions[(i - youIndex + count) % count] ?? 'south',
    isYou: player.id === humanId,
    handCount: player.hand.length,
    isTurn: player.id === acting
  }));
}

export function seatAt(seats: Seat[], position: SeatPosition): Seat | undefined {
  return seats.find(s => s.position === position);
}

/**
 * Which side a player scores for — the player themselves in 2-player, their team in 4-player.
 *
 * A deliberate read-only mirror of the engine's own resolution (from `state.teams`, never from the
 * never-populated `player.teamId`). It returns null instead of throwing when teams aren't assigned
 * yet: in 4-player the default partnerships are only written during the main deal, so between the
 * call and the opening action a 4-player state genuinely has no sides, and a display helper must
 * not take the table down over that.
 */
export function sideOfPlayer(state: GameState, playerId: string): string | null {
  if (state.mode === '2player') return playerId;
  return state.teams.find(t => t.playerIds.includes(playerId))?.id ?? null;
}

/** True once every side in this game can actually be resolved — i.e. once it's meaningful to ask
 * the engine for a per-side score breakdown. */
export function sidesAreSettled(state: GameState): boolean {
  return state.players.every(p => sideOfPlayer(state, p.id) !== null);
}

/** The sides in seat order, nearest side first, so "yours" always reads on the left. */
export function sidesInPlay(state: GameState, humanId: string): string[] {
  const yourSide = sideOfPlayer(state, humanId);
  const sides: string[] = [];
  for (const player of state.players) {
    const side = sideOfPlayer(state, player.id);
    if (side && !sides.includes(side)) sides.push(side);
  }
  return sides.sort((a, b) => (a === yourSide ? -1 : b === yourSide ? 1 : 0));
}

/**
 * How an owner is named on the table.
 *
 * Takes either kind of identifier, because the frozen House type uses both: a house with a SOLE
 * owner records that owner as an individual player id, while a jointly owned one records side ids
 * (which are team ids in four-handed play). Players are checked first, so the two-handed case —
 * where a side id and a player id are the same string — resolves the same way it always has.
 */
export function sideLabel(state: GameState, owner: string, humanId: string): string {
  const player = state.players.find(p => p.id === owner);
  if (player) return player.id === humanId ? 'You' : player.name;

  const team = state.teams.find(t => t.id === owner);
  if (!team) return owner;
  return team.playerIds
    .map(id => (id === humanId ? 'You' : (state.players.find(p => p.id === id)?.name ?? id)))
    .join(' & ');
}

/**
 * Every identifier that means "your side" when reading a house's `ownerSides`.
 *
 * A house names its owner as a player id when one player owns it outright and as a side id when
 * both sides have a stake, so asking "is this mine?" has to accept either — and in four-handed
 * play, a house your PARTNER built is your side's house too. Collecting all of those up front
 * keeps that question a simple membership test wherever it's asked.
 */
export function yourOwnerIds(state: GameState, humanId: string): string[] {
  const ids = new Set<string>([humanId]);
  const side = sideOfPlayer(state, humanId);
  if (side) {
    ids.add(side);
    const team = state.teams.find(t => t.id === side);
    team?.playerIds.forEach(id => ids.add(id));
  }
  return [...ids];
}
