import type { OpeningAction } from '../types';
import type { OrchestratedGame } from '../engine/roundOrchestrator';
import type { NormalPlayMove } from '../engine/moveExecution';
import { chooseBid, chooseMove, chooseOpeningAction } from './strategy';

export { evaluate } from './evaluate';
export type { EvaluationBreakdown } from './evaluate';
export { estimatedCaptureRisk, unseenCards } from './cardCounting';
export { chooseBid, chooseMove, chooseOpeningAction } from './strategy';
export type { BotDecision, ScoredCandidate } from './strategy';

// ---------------------------------------------------------------------------
// Debug/observability (Section 14) — a simple in-memory log of every bot decision, with the
// candidates it considered and their scores. Not a polished explanation system: just enough to
// see, during development or in a debug panel, what the bot was weighing and why it picked what
// it picked. Cleared per game by the caller (see clearBotDebugLog) — this module keeps no game
// state itself, only a decision trail.
// ---------------------------------------------------------------------------

export interface BotLogEntry {
  playerId: string;
  decisionType: 'bid' | 'openingAction' | 'move';
  chosen: unknown;
  score: number;
  candidateCount: number;
}

let debugLog: BotLogEntry[] = [];

export function getBotDebugLog(): readonly BotLogEntry[] {
  return debugLog;
}

export function clearBotDebugLog(): void {
  debugLog = [];
}

function record(entry: BotLogEntry): void {
  debugLog.push(entry);
  // eslint-disable-next-line no-console
  console.debug(`[bot] ${entry.playerId} ${entry.decisionType} ->`, entry.chosen, `score=${entry.score.toFixed(2)} of ${entry.candidateCount} candidates`);
}

/** Convenience wrappers that make the decision AND log it — these are what the UI/autoplay
 * runner should call day to day; `chooseBid`/`chooseOpeningAction`/`chooseMove` from `./strategy`
 * remain available directly for tests that want the full candidate list without side effects. */

export function botChooseBid(game: OrchestratedGame, playerId: string): number {
  const decision = chooseBid(game, playerId);
  record({ playerId, decisionType: 'bid', chosen: decision.choice, score: decision.score, candidateCount: decision.candidates.length });
  return decision.choice;
}

export function botChooseOpeningAction(game: OrchestratedGame, playerId: string): OpeningAction {
  const decision = chooseOpeningAction(game, playerId);
  record({ playerId, decisionType: 'openingAction', chosen: decision.choice, score: decision.score, candidateCount: decision.candidates.length });
  return decision.choice;
}

export function botChooseMove(game: OrchestratedGame, playerId: string): NormalPlayMove {
  const decision = chooseMove(game, playerId);
  record({ playerId, decisionType: 'move', chosen: decision.choice, score: decision.score, candidateCount: decision.candidates.length });
  return decision.choice;
}
