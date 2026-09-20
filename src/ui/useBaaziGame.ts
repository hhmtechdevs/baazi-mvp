import { useCallback, useEffect, useRef, useState } from 'react';
import type { CaptureTarget, OpeningAction } from '../types';
import type { GameLengthConfig, OrchestratedGame, RoundCompletionResult } from '../engine/roundOrchestrator';
import {
  completeRound,
  discoverLegalMoves,
  isRoundComplete,
  startNextRound,
  startRound,
  submitBid,
  submitMove,
  submitOpeningAction
} from '../engine/roundOrchestrator';
import type { NormalPlayMove } from '../engine/moveExecution';
import { flattenOptionsForHand, withOnlyVisibleHand } from '../engine/moveAdapter';
import { botChooseBid, botChooseMove, botChooseOpeningAction } from '../botStrategy';
import { sideLabel } from './table';

/** How many of the bidder's dealt cards are actually visible before their opening move — see
 * withOnlyVisibleHand. Kept here (not re-exported from App.tsx) since this hook needs it too, for
 * the bid-safety check below. */
export const VISIBLE_PRE_OPENING_CARD_COUNT = 4;

// ---------------------------------------------------------------------------
// The one place React touches the engine. Every state transition here is produced by calling
// roundOrchestrator.ts — this hook never decides legality, never computes scores, never decides
// whose turn it is; it only holds the current OrchestratedGame, dispatches human actions through
// the orchestrator exactly as they're chosen, and triggers the bot's turn (via src/bot, which
// itself only ever submits through the same orchestrator functions) after a short human-readable
// delay so the bot's play can actually be observed.
// ---------------------------------------------------------------------------

export const HUMAN_ID = 'you';
export const BOT_ID = 'bot';

export const BOT_DELAY_MS_DEFAULT = 5_000;

/** The computer opponent's player-facing name — "bot" stays an internal term only. */
export const OPPONENT_NAME = 'Baazigar';

/**
 * Which table you sat down at. Both run on the same engine and the same 2-/4-player support that
 * has always been there — the only difference is how many seats are filled and by whom.
 *
 * 'family' is the four-handed table. Until network play exists, the three seats that are not yours
 * are played by the same strategy module Baazigar uses; they are named for where they sit, since
 * they stand in for the people who will eventually occupy them.
 */
export type TableKind = 'practice' | 'family';

const TABLES: Record<TableKind, { mode: '2player' | '4player'; players: { id: string; name: string }[] }> = {
  practice: {
    mode: '2player',
    players: [
      { id: HUMAN_ID, name: 'You' },
      { id: BOT_ID, name: OPPONENT_NAME }
    ]
  },
  // Seat order is also partnership order: the engine's 4-player deal pairs seats 0+2 and 1+3, so
  // listing you, your left, your partner, your right puts your partner across the blanket.
  family: {
    mode: '4player',
    players: [
      { id: HUMAN_ID, name: 'You' },
      { id: 'left', name: 'Left' },
      { id: 'partner', name: 'Partner' },
      { id: 'right', name: 'Right' }
    ]
  }
};

/**
 * Which bid values are actually safe to offer: Ingredient 2's submitBid only checks that the
 * value is an integer 9–13, it does not check the bidder actually holds a usable card for it —
 * that's discovered later, during the opening decision. Offering a value that leads to zero
 * legal opening actions would strand the player. Rather than re-deriving "does my hand support
 * this" as a rule in React, this asks the engine directly: simulate the bid, then ask
 * discoverLegalMoves what it produces.
 *
 * Checked entirely against the bidder's FIRST 4 dealt cards (withOnlyVisibleHand) — per the
 * corrected 2-player deal, those 4 (guaranteed by the engine to contain a 9–13 card) are the only
 * cards the bidder has actually seen before calling; the rest of their hand isn't revealed until
 * after the opening move. The hand is truncated BEFORE discovery, not filtered after — a build
 * option's "retains" check (legalMoves.ts) inspects the whole hand it's given, so discovering
 * against the true 12-card hand could call a value "safe" purely because a HIDDEN card (position
 * 5+) satisfies that check, offering something that doesn't actually look reachable from what the
 * player can see. In 4-player mode this is a no-op — the bidder's whole hand IS 4 cards.
 */
export function safeBidValues(game: OrchestratedGame, playerId: string): number[] {
  const safe: number[] = [];
  for (let value = 9; value <= 13; value++) {
    try {
      const afterBid = submitBid(game, playerId, value);
      const visibleOnly = withOnlyVisibleHand(afterBid, playerId, VISIBLE_PRE_OPENING_CARD_COUNT);
      const options = flattenOptionsForHand(discoverLegalMoves(visibleOnly, playerId));
      if (options.length > 0) safe.push(value);
    } catch {
      // Not a legal bid from this state at all — simply not offered.
    }
  }
  return safe;
}

export interface BaaziUiState {
  game: OrchestratedGame | null;
  gameLengthConfig: GameLengthConfig | null;
  table: TableKind | null;
  log: string[];
  lastRoundResult: RoundCompletionResult | null;
  /** What each side scored in the last round played. Outlives `lastRoundResult`, which is cleared
   * when the next round is dealt, so the tally at the top can keep showing it. */
  lastRoundScores: Record<string, number> | null;
  /** Whoever is currently taking their time over a decision, or null when it's your move. */
  thinkingPlayerId: string | null;
  botDelayMs: number;
}

/** The seat that has to act and isn't yours — whether that's the call, the opening play, or a
 * normal turn. Null when the game is waiting on you, or on nothing. */
function seatAwaitingComputer(game: OrchestratedGame): string | null {
  const state = game.state;
  if (state.phase === 'bidding' || state.phase === 'revealing') {
    return state.bidderId && state.bidderId !== HUMAN_ID ? state.bidderId : null;
  }
  if (state.phase === 'playing') {
    const current = state.players[state.currentPlayerIndex]?.id;
    return current && current !== HUMAN_ID ? current : null;
  }
  return null;
}

function describeOpeningAction(action: OpeningAction): string {
  if (action.type === 'build') return 'built a house';
  if (action.type === 'capture') return 'captured from the floor';
  return 'threw a card';
}

function describeMove(move: NormalPlayMove): string {
  switch (move.kind) {
    case 'build': return 'built a house';
    case 'cement': return 'combined into a house';
    case 'break': return "changed an opponent's house";
    case 'mergeFix': return 'merged houses';
    case 'addToFixed': return 'added to a fixed house';
    case 'capture': return 'captured from the floor';
    case 'throw': return 'threw a card';
  }
}

export function useBaaziGame() {
  const [state, setState] = useState<BaaziUiState>({
    game: null,
    gameLengthConfig: null,
    table: null,
    log: [],
    lastRoundResult: null,
    lastRoundScores: null,
    thinkingPlayerId: null,
    botDelayMs: BOT_DELAY_MS_DEFAULT
  });
  const timerRef = useRef<number | undefined>(undefined);

  const appendLog = useCallback((line: string) => {
    setState(s => ({ ...s, log: [...s.log, line] }));
  }, []);

  const startNewGame = useCallback((gameLengthConfig: GameLengthConfig, table: TableKind) => {
    const seats = TABLES[table];
    const dealerId = seats.players[Math.floor(Math.random() * seats.players.length)].id;
    const game = startRound({
      gameId: `baazi-${Date.now()}`,
      mode: seats.mode,
      players: seats.players,
      dealerId,
      gameLengthConfig
    });
    const nameOf = (id: string | null) => seats.players.find(p => p.id === id)?.name ?? id ?? '';
    setState({
      game,
      gameLengthConfig,
      table,
      log: [`New game started. ${nameOf(dealerId)} deals — ${nameOf(game.state.bidderId)} calls.`],
      lastRoundResult: null,
      lastRoundScores: null,
      thinkingPlayerId: null,
      botDelayMs: BOT_DELAY_MS_DEFAULT
    });
  }, []);

  const submitHumanBid = useCallback((value: number) => {
    setState(s => {
      if (!s.game) return s;
      const game = submitBid(s.game, HUMAN_ID, value);
      return { ...s, game, log: [...s.log, `You bid ${value}.`] };
    });
  }, []);

  const submitHumanOpeningAction = useCallback((action: OpeningAction) => {
    setState(s => {
      if (!s.game) return s;
      const game = submitOpeningAction(s.game, HUMAN_ID, action);
      return { ...s, game, log: [...s.log, `You ${describeOpeningAction(action)}.`] };
    });
  }, []);

  const submitHumanMove = useCallback((move: NormalPlayMove) => {
    setState(s => {
      if (!s.game) return s;
      const game = submitMove(s.game, HUMAN_ID, move);
      return { ...s, game, log: [...s.log, `You ${describeMove(move)}.`] };
    });
  }, []);

  const finishRound = useCallback(() => {
    setState(s => {
      if (!s.game || !s.gameLengthConfig) return s;
      const result = completeRound(s.game);
      const scoreLine = Object.entries(result.state.scores)
        .map(([side, v]) => `${sideLabel(result.state, side, HUMAN_ID)}: ${v}`)
        .join(', ');
      return {
        ...s,
        game: { ...s.game, state: result.state },
        lastRoundResult: result,
        lastRoundScores: Object.fromEntries(Object.entries(result.breakdown).map(([side, b]) => [side, b.total])),
        log: [...s.log, `Round complete. Scores — ${scoreLine}.`, result.gameOver ? 'Game complete.' : '']
          .filter(Boolean)
      };
    });
  }, []);

  const startNextRoundClicked = useCallback(() => {
    setState(s => {
      if (!s.game || !s.lastRoundResult) return s;
      const nextGame = startNextRound(s.game, s.lastRoundResult);
      const caller = nextGame.state.players.find(p => p.id === nextGame.state.bidderId)?.name ?? 'Someone';
      return {
        ...s,
        game: nextGame,
        lastRoundResult: null,
        log: [...s.log, `Round ${nextGame.state.roundNumber} dealt. ${caller} calls.`]
      };
    });
  }, []);

  const setBotDelayMs = useCallback((ms: number) => setState(s => ({ ...s, botDelayMs: ms })), []);

  // Take the turn of whichever seat isn't yours — bid, opening action, or a normal-play move —
  // after a short delay, so the decision can actually be watched. Seat-agnostic on purpose: the
  // strategy module has always taken (game, playerId), so the four-handed Family table needs the
  // same single code path the two-handed table uses, not a second one. This effect ONLY calls into
  // botStrategy's public API, which itself only ever submits through the orchestrator functions
  // above — no rule, score or turn decision is made here.
  useEffect(() => {
    const game = state.game;
    if (!game) return undefined;

    const seatId = seatAwaitingComputer(game);
    if (!seatId) return undefined;

    const phase = game.state.phase;
    const who = game.state.players.find(p => p.id === seatId)?.name ?? seatId;

    setState(s => ({ ...s, thinkingPlayerId: seatId }));
    timerRef.current = window.setTimeout(() => {
      if (phase === 'bidding') {
        const value = botChooseBid(game, seatId);
        setState(s => ({ ...s, game: submitBid(game, seatId, value), thinkingPlayerId: null, log: [...s.log, `${who} bid ${value}.`] }));
      } else if (phase === 'revealing') {
        const action = botChooseOpeningAction(game, seatId);
        setState(s => ({
          ...s,
          game: submitOpeningAction(game, seatId, action),
          thinkingPlayerId: null,
          log: [...s.log, `${who} ${describeOpeningAction(action)}.`]
        }));
      } else {
        const move = botChooseMove(game, seatId);
        setState(s => ({
          ...s,
          game: submitMove(game, seatId, move),
          thinkingPlayerId: null,
          log: [...s.log, `${who} ${describeMove(move)}.`]
        }));
      }
    }, state.botDelayMs);

    return () => window.clearTimeout(timerRef.current);
  }, [state.game, state.botDelayMs]);

  return {
    ...state,
    startNewGame,
    submitHumanBid,
    submitHumanOpeningAction,
    submitHumanMove,
    finishRound,
    startNextRoundClicked,
    setBotDelayMs,
    isRoundComplete: state.game ? isRoundComplete(state.game) : false,
    safeBidValuesForHuman: state.game ? safeBidValues(state.game, HUMAN_ID) : []
  };
}

export type { CaptureTarget };
