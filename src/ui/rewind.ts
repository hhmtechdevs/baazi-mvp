import type { GameState } from '../types';
import type { OrchestratedGame } from '../engine/roundOrchestrator';
import { discoverLegalMoves } from '../engine/roundOrchestrator';
import { flattenOptionsForHand } from '../engine/moveAdapter';
import { actingPlayerId } from './table';
import { describeMove } from './moveNarrative';
import type { MoveReceipt } from './moveNarrative';

// ---------------------------------------------------------------------------
// Walking back through a game.
//
// The whole reason this is cheap: every engine function is pure and returns a NEW state, so the
// game already produces a trail of immutable snapshots as it goes — nothing here has to re-run
// anything, undo anything, or know a single rule. Keeping a reference to each one is the entire
// implementation of rewind.
//
// This exists because a position seen once at the table is gone. Twice now an opening move has
// looked wrong and the position died with the round, leaving a description to argue with instead
// of a state to test. A report from here is a state plus the options the engine actually offered
// for it, which is precisely what a regression test needs.
// ---------------------------------------------------------------------------

/** Cap on remembered snapshots. A long match is a few hundred; this is simply a ceiling. */
export const MAX_REMEMBERED = 400;

/**
 * Appends a snapshot, unless it is the one already on the end.
 *
 * Identity, not equality: the engine hands back a new object for every real transition and the
 * same object when nothing happened, so object identity is already the exact question being asked.
 */
export function remember(history: OrchestratedGame[], game: OrchestratedGame | null): OrchestratedGame[] {
  if (!game) return history;
  if (history[history.length - 1] === game) return history;
  const next = [...history, game];
  return next.length > MAX_REMEMBERED ? next.slice(next.length - MAX_REMEMBERED) : next;
}

/** Clamps a cursor to the snapshots that exist. */
export function stepTo(history: OrchestratedGame[], index: number): number {
  if (history.length === 0) return 0;
  return Math.max(0, Math.min(history.length - 1, index));
}

/**
 * A one-line account of where a snapshot sits, for the scrubber: round, phase and whose move.
 * Deliberately short — the table itself is showing the position.
 */
export function snapshotLabel(game: OrchestratedGame): string {
  const state = game.state;
  const acting = actingPlayerId(state);
  const who = state.players.find(p => p.id === acting)?.name;
  const phase =
    state.phase === 'bidding' ? 'the call'
    : state.phase === 'revealing' ? 'the opening play'
    : state.phase === 'playing' ? `turn ${state.turnNumber}`
    : state.phase === 'roundEnd' ? 'round scored'
    : state.phase === 'gameEnd' ? 'game over'
    : state.phase;
  return `Round ${state.roundNumber} · ${phase}${who ? ` · ${who}` : ''}`;
}

export interface PositionReport {
  takenAt: string;
  label: string;
  /** Whose decision this position is waiting on. */
  actingPlayerId: string | null;
  /** The called value, when one has been called. */
  bidValue: number | null;
  /** Everybody's hand, the floor, and the rest of the state exactly as the engine holds it. */
  state: GameState;
  /**
   * What the engine OFFERED the acting player here, per card. The point of the whole exercise:
   * "the move I wanted was not there" is only answerable against this list, and reading it out of
   * a live browser is the one thing that cannot be done after the round is over.
   */
  offered: Record<string, unknown[]> | { error: string };
  /** The same list flattened, which is usually the quicker thing to read. */
  offeredCount: number;
}

/**
 * Everything needed to rebuild this exact position in a test.
 *
 * Takes the options from the engine at report time rather than storing them, so the report can
 * never disagree with what the rules currently say — if a report shows a move missing, the move is
 * missing now, in this build.
 */
export function positionReport(game: OrchestratedGame): PositionReport {
  const acting = actingPlayerId(game.state) ?? null;
  let offered: PositionReport['offered'] = {};
  let offeredCount = 0;
  try {
    if (acting) {
      const byCard = discoverLegalMoves(game, acting);
      offered = byCard as unknown as Record<string, unknown[]>;
      offeredCount = flattenOptionsForHand(byCard).length;
    }
  } catch (e) {
    // A position where discovery itself throws is the most interesting report of all, so it is
    // captured rather than allowed to take the table down.
    offered = { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
  return {
    takenAt: new Date().toISOString(),
    label: snapshotLabel(game),
    actingPlayerId: acting,
    bidValue: game.state.bidValue,
    state: game.state,
    offered,
    offeredCount
  };
}

/** The report as a pasteable block. */
export function reportText(game: OrchestratedGame): string {
  return JSON.stringify(positionReport(game), null, 2);
}

/**
 * The move that produced the position at `index`, read straight out of the two snapshots around
 * it. Null at the very first position, and whenever the change was not a move — a fresh deal, a
 * scored round — which is the same honesty describeMove already practises.
 */
export function moveInto(history: OrchestratedGame[], index: number): MoveReceipt | null {
  const before = history[index - 1];
  const after = history[index];
  if (!before || !after) return null;
  if (before.state.roundNumber !== after.state.roundNumber) return null;
  return describeMove(before.state, after.state);
}

// ---------------------------------------------------------------------------
// A shared table's history.
// ---------------------------------------------------------------------------

/**
 * Records the positions of a table that arrives over the network.
 *
 * Practice can lean on object identity — the engine hands back a new object per move and the same
 * one otherwise. A shared table cannot: its state is re-parsed from JSON on every poll, so the
 * game object is new every tick even when nothing happened. The envelope's own revision is what
 * actually changes when a move lands, so that is what this keys on.
 *
 * Review only. There is no playing on from an earlier position here: a Family table is other
 * people's game too, and one player cannot wind it back for everybody.
 */
export interface SharedSnapshot {
  revision: number;
  game: OrchestratedGame;
}

export function rememberShared(
  history: SharedSnapshot[],
  revision: number | undefined,
  game: OrchestratedGame | null | undefined
): SharedSnapshot[] {
  if (!game || revision === undefined) return history;
  if (history[history.length - 1]?.revision === revision) return history;
  const next = [...history, { revision, game }];
  return next.length > MAX_REMEMBERED ? next.slice(next.length - MAX_REMEMBERED) : next;
}
