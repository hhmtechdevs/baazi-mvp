import { useEffect, useRef, useState } from 'react';
import { describeMove } from './moveNarrative';
import type { MoveReceipt } from './moveNarrative';
import type { GameState } from '../types';

/**
 * Keeps the last move's receipt on screen until the next one replaces it.
 *
 * Watches the state go by and diffs each change (see moveNarrative). It holds onto the result
 * rather than deriving it fresh each render, because what a player needs is the move that just
 * happened, which by definition is no longer visible in the current state alone.
 *
 * Clears itself at a new round: the first move of a round should not be read under a sentence
 * about the last card of the previous one.
 */
export function useMoveReceipt(state: GameState): MoveReceipt | null {
  const previous = useRef<GameState | null>(null);
  const [receipt, setReceipt] = useState<MoveReceipt | null>(null);

  useEffect(() => {
    const prev = previous.current;
    previous.current = state;
    if (!prev || prev === state) return;
    if (prev.roundNumber !== state.roundNumber || prev.gameId !== state.gameId) {
      setReceipt(null);
      return;
    }
    const next = describeMove(prev, state);
    if (next) setReceipt(next);
  }, [state]);

  return receipt;
}
