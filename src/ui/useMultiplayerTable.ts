import { useCallback, useEffect, useRef, useState } from 'react';
import { createTable, loadTable, saveTable, watchTable } from '../multiplayer/store';
import { dealNextRound, nextHostStep } from '../multiplayer/host';
import { claimSeat, expectedActor, normaliseCode, seatOf } from '../multiplayer/protocol';
import type { ActionRequest, SeatId, TableEnvelope } from '../multiplayer/protocol';
import { codeFromUrl, forgetTable, lastTable, rememberTable, sessionId } from '../multiplayer/session';
import { isSupabaseConfigured } from '../supabase';
import type { OpeningAction } from '../types';
import type { NormalPlayMove } from '../engine/moveExecution';
import { BOT_DELAY_MS_DEFAULT } from './useBaaziGame';

/**
 * One real table, shared between two browsers.
 *
 * The shape of it: every browser READS the same row and renders it, and exactly one browser — the
 * host, the one that made the table — WRITES it. The host is the only place the engine runs, so
 * there is one game rather than four locally simulated ones that have to be kept in step.
 *
 * A guest never changes the game. It leaves a request in the row; the host picks it up, checks the
 * seat and the turn, asks the engine whether the move is legal, and writes the result. So the
 * answer to "what happened" always comes from one engine, and both screens are showing the same
 * authoritative state rather than two hopefully-identical simulations.
 *
 * Every write is a compare-and-swap on the revision it was derived from (see store.saveTable). A
 * write built on a table that has since moved on doesn't land — it comes back as a conflict, and
 * we reload and think again rather than clobbering somebody.
 */

export type TablePhase = 'idle' | 'creating' | 'joining' | 'at-table' | 'error';

export interface MultiplayerTable {
  phase: TablePhase;
  envelope: TableEnvelope | null;
  mySeat: SeatId | null;
  isHost: boolean;
  error: string | null;
  /** A code found in the URL or left over from last time, offered as a way straight back in. */
  suggestedCode: string | null;
  create: (hostName?: string) => Promise<void>;
  join: (code: string, name?: string) => Promise<void>;
  leave: () => void;
  submitBid: (value: number) => void;
  submitOpeningAction: (action: OpeningAction) => void;
  submitMove: (move: NormalPlayMove) => void;
  /** Host only — deals the next round once the scores have been read. Null for everyone else, so
   * the button simply isn't there rather than being there and refusing. */
  dealNext: (() => void) | null;
  isMyTurn: boolean;
}

function requestId(): string {
  return `r-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

export function useMultiplayerTable(): MultiplayerTable {
  const me = sessionId();
  const [phase, setPhase] = useState<TablePhase>('idle');
  const [envelope, setEnvelope] = useState<TableEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [suggestedCode] = useState<string | null>(() => codeFromUrl() ?? lastTable());

  // The envelope the host loop is currently reasoning about. Kept in a ref as well as state so the
  // loop always acts on the latest table rather than whatever a closure captured.
  const current = useRef<TableEnvelope | null>(null);
  const writing = useRef(false);
  const aiTimer = useRef<number | undefined>(undefined);

  const adopt = useCallback((next: TableEnvelope) => {
    current.current = next;
    setEnvelope(next);
  }, []);

  // ---- walking back in -----------------------------------------------------
  // A refresh, a closed tab, a phone that went to sleep: the table is in Supabase, and this session
  // already has a seat recorded against it, so pick that seat back up rather than starting over.
  //
  // Only ever RESUMES — it never claims a seat. Someone opening an invite link has no seat yet and
  // has to go through joining, so simply having a code lying around can't sit you down at a table
  // you were never at.
  useEffect(() => {
    let cancelled = false;
    const code = lastTable();
    // No client means no shared tables to walk back into — and Practice must not be held up by it.
    if (!code || !isSupabaseConfigured) return undefined;

    void (async () => {
      const table = await loadTable(code);
      if (cancelled) return;
      if (!table || !seatOf(table, me)) {
        // The table is gone, or this browser was never seated at it. Forget it so a stale code
        // doesn't keep trying.
        forgetTable();
        return;
      }
      adopt(table);
      setPhase('at-table');
    })();

    return () => {
      cancelled = true;
    };
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- subscribe -----------------------------------------------------------
  useEffect(() => {
    const code = envelope?.code;
    if (!code) return undefined;
    const stop = watchTable(code, incoming => {
      // Realtime can deliver out of order; never move the table backwards.
      if ((current.current?.revision ?? 0) >= incoming.revision) return;
      adopt(incoming);
    });
    return stop;
  }, [envelope?.code, adopt]);

  // ---- the host loop -------------------------------------------------------
  // Only the host runs this. It takes one step at a time and writes it conditionally; a conflict
  // means somebody else got there first, so it reloads and reconsiders instead of forcing its
  // version through.
  const isHost = !!envelope && envelope.hostSessionId === me;

  useEffect(() => {
    if (!isHost) return undefined;
    const table = current.current;
    if (!table || writing.current) return undefined;

    const step = nextHostStep(table, { aiIsReady: true });
    if (!step) return undefined;

    // An AI seat waits a beat so its play can be watched; everything else goes immediately.
    const delay = step.kind === 'ai' ? BOT_DELAY_MS_DEFAULT : 0;

    const run = async () => {
      const from = current.current;
      if (!from || writing.current) return;
      const decided = nextHostStep(from, { aiIsReady: true });
      if (!decided) return;

      writing.current = true;
      try {
        const result = await saveTable(decided.envelope, from.revision);
        if (result.ok) {
          adopt(result.envelope);
        } else if (result.conflict) {
          const fresh = await loadTable(from.code);
          if (fresh) adopt(fresh);
        } else {
          setError(result.error);
        }
      } finally {
        writing.current = false;
      }
    };

    if (delay === 0) {
      void run();
      return undefined;
    }
    aiTimer.current = window.setTimeout(() => void run(), delay);
    return () => window.clearTimeout(aiTimer.current);
  }, [isHost, envelope, adopt]);

  // ---- create / join / leave ----------------------------------------------
  const create = useCallback(async (hostName?: string) => {
    setPhase('creating');
    setError(null);
    try {
      const table = await createTable(me, hostName);
      rememberTable(table.code);
      adopt(table);
      setPhase('at-table');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the game.');
      setPhase('error');
    }
  }, [me, adopt]);

  const join = useCallback(async (raw: string, name?: string) => {
    const code = normaliseCode(raw);
    if (!code) {
      setError('That code doesn’t look right — it’s four letters and numbers.');
      return;
    }
    setPhase('joining');
    setError(null);

    const table = await loadTable(code);
    if (!table) {
      setError('No game with that code.');
      setPhase('idle');
      return;
    }

    const claim = claimSeat(table, me, name);
    if (!claim.ok) {
      setError(claim.reason);
      setPhase('idle');
      return;
    }
    if (claim.rejoined) {
      // Already had a seat here — walk straight back to it, changing nothing.
      rememberTable(code);
      adopt(table);
      setPhase('at-table');
      return;
    }

    const result = await saveTable(claim.envelope, table.revision);
    if (result.ok) {
      rememberTable(code);
      adopt(result.envelope);
      setPhase('at-table');
      return;
    }
    if (result.conflict) {
      // Somebody sat down in the same instant. Re-read and see whether a seat is still going.
      const fresh = await loadTable(code);
      const retry = fresh ? claimSeat(fresh, me, name) : null;
      if (fresh && retry?.ok) {
        const second = await saveTable(retry.envelope, fresh.revision);
        if (second.ok) {
          rememberTable(code);
          adopt(second.envelope);
          setPhase('at-table');
          return;
        }
      }
      setError('Someone just took the last seat.');
      setPhase('idle');
      return;
    }
    setError(result.error);
    setPhase('idle');
  }, [me, adopt]);

  const leave = useCallback(() => {
    forgetTable();
    current.current = null;
    setEnvelope(null);
    setError(null);
    setPhase('idle');
  }, []);

  // ---- acting --------------------------------------------------------------
  const mySeat = envelope ? seatOf(envelope, me) : null;
  const isMyTurn = !!envelope && !!mySeat && expectedActor(envelope) === mySeat;

  /**
   * Ask to play. The host applies its own actions through the same authority path a guest's action
   * takes — no shortcut for being the host — so there is one route into the engine and one place
   * that decides whether something is allowed.
   */
  const request = useCallback(
    (kind: ActionRequest['kind'], payload: unknown) => {
      const table = current.current;
      if (!table || !mySeat) return;

      const action: ActionRequest = {
        id: requestId(),
        sessionId: me,
        seat: mySeat,
        forGameRevision: table.gameRevision,
        kind,
        payload
      };

      void (async () => {
        const withRequest: TableEnvelope = { ...table, request: action, revision: table.revision + 1 };
        const result = await saveTable(withRequest, table.revision);
        if (result.ok) adopt(result.envelope);
        else if (result.conflict) {
          const fresh = await loadTable(table.code);
          if (fresh) adopt(fresh);
        }
      })();
    },
    [me, mySeat, adopt]
  );

  const dealNext = useCallback(() => {
    void (async () => {
      const table = current.current;
      if (!table || table.hostSessionId !== me || !table.lastResult || table.lastResult.gameOver) return;
      const result = await saveTable(dealNextRound(table), table.revision);
      if (result.ok) adopt(result.envelope);
      else if (result.conflict) {
        const fresh = await loadTable(table.code);
        if (fresh) adopt(fresh);
      }
    })();
  }, [me, adopt]);

  return {
    phase,
    envelope,
    mySeat,
    isHost,
    error,
    suggestedCode,
    dealNext: isHost && envelope?.lastResult && !envelope.lastResult.gameOver ? dealNext : null,
    create,
    join,
    leave,
    submitBid: useCallback((value: number) => request('bid', value), [request]),
    submitOpeningAction: useCallback((action: OpeningAction) => request('openingAction', action), [request]),
    submitMove: useCallback((move: NormalPlayMove) => request('move', move), [request]),
    isMyTurn
  };
}
