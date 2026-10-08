import { useEffect, useState } from 'react';
import type { OrchestratedGame } from '../engine/roundOrchestrator';
import { reportText, snapshotLabel } from './rewind';

/**
 * The scrubber.
 *
 * Hidden until asked for, because a game of cards should not carry a debugger across the bottom of
 * it. Alt+R brings it up, and `?rewind` has it up from the start for a session that is going
 * looking for something.
 *
 * Copy position is the point of the whole thing: it writes out the state AND the moves the engine
 * offered for it, which turns "that opening looked wrong" into something that can be pinned in a
 * test and argued with.
 */
export function RewindBar(props: {
  history: OrchestratedGame[];
  index: number;
  isReviewing: boolean;
  onStepBack: () => void;
  onStepForward: () => void;
  /** Absent on a shared table, where one player may not wind the game back for everybody. */
  onResumeHere?: () => void;
  onLive: () => void;
  /** Absent on a shared table: dealing is the host's business and not a review action. */
  onDealAgain?: () => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);
  const game = props.history[props.index];

  /**
   * navigator.clipboard does not exist outside a secure context, which is exactly the case that
   * matters most: a phone on the local network over plain http. Writing the report to the console
   * is no use on a device with no console, so the text is put on screen instead, selected and
   * ready to be copied by hand.
   */
  const copy = async () => {
    if (!game) return;
    const text = reportText(game);
    try {
      if (!navigator.clipboard) throw new Error('no clipboard in this context');
      await navigator.clipboard.writeText(text);
      setCopied('Position copied.');
      window.setTimeout(() => setCopied(null), 2600);
    } catch {
      setFallback(text);
    }
  };

  if (!game) return null;

  return (
    <div className="baazi-rewind" role="region" aria-label="Rewind">
      <button onClick={props.onStepBack} disabled={props.index <= 0} aria-label="Back one position">
        ◀
      </button>
      <div className="baazi-rewind-where">
        <span className="baazi-rewind-label">{snapshotLabel(game)}</span>
        <span className="baazi-rewind-count">
          {props.index + 1} / {props.history.length}
          {!props.isReviewing && ' · live'}
        </span>
      </div>
      <button
        onClick={props.onStepForward}
        disabled={props.index >= props.history.length - 1}
        aria-label="Forward one position"
      >
        ▶
      </button>
      <button className="baazi-rewind-action" onClick={copy}>
        <span className="baazi-roomy">Copy position</span>
        <span className="baazi-tight">Copy</span>
      </button>
      {/* The hunt for an opening that misbehaves is a loop of deal, look, deal again — and every
          deal here puts the call in your hands, so the opening is always yours to inspect. */}
      {props.onDealAgain && (
        <button className="baazi-rewind-action" onClick={props.onDealAgain}>
          <span className="baazi-roomy">Deal again</span>
          <span className="baazi-tight">Deal</span>
        </button>
      )}
      {props.isReviewing && (
        <>
          {props.onResumeHere && (
            <button className="baazi-rewind-action" onClick={props.onResumeHere}>
              <span className="baazi-roomy">Play from here</span>
              <span className="baazi-tight">Play</span>
            </button>
          )}
          <button className="baazi-rewind-action" onClick={props.onLive}>
            <span className="baazi-roomy">Back to live</span>
            <span className="baazi-tight">Live</span>
          </button>
        </>
      )}
      <button className="baazi-rewind-close" onClick={props.onClose} aria-label="Hide rewind">
        ✕
      </button>
      {copied && <span className="baazi-rewind-said">{copied}</span>}
      {fallback !== null && (
        <div className="baazi-rewind-fallback">
          <p>Select all and copy — this browser will not write to the clipboard itself.</p>
          <textarea
            readOnly
            value={fallback}
            ref={el => el?.select()}
            onFocus={e => e.currentTarget.select()}
          />
          <button onClick={() => setFallback(null)}>Done</button>
        </div>
      )}
    </div>
  );
}

/**
 * Whether the strip is up.
 *
 * Opened by `?rewind` in the address bar or by Alt+R (keyed on the physical key, so the character
 * the modifier produces on this layout does not matter). A keyboard shortcut cannot be the only
 * way back, though: there is no Alt key on a phone, and a browser is free to swallow the chord on
 * a laptop — which is exactly what happened. So once the strip has been opened, closing it leaves
 * a small handle behind rather than vanishing, and a game that never opened it stays completely
 * clean.
 */
const REMEMBERED = 'baazi.rewind';

/** Whether rewind was left switched on. Survives reloads, so getting the strip back never depends
 * on retyping a URL or on a keyboard chord the browser might swallow. */
function rememberedOn(): boolean {
  try {
    return window.localStorage.getItem(REMEMBERED) === 'on';
  } catch {
    return false; // private window, blocked storage — the URL still works
  }
}

function remember(on: boolean): void {
  try {
    window.localStorage.setItem(REMEMBERED, on ? 'on' : 'off');
  } catch {
    // Nothing to do; the session simply will not be remembered.
  }
}

export function useRewindVisible(): {
  visible: boolean;
  everOpened: boolean;
  show: () => void;
  hide: () => void;
} {
  // `?rewind` switches it ON and keeps it on. Once a session has used rewind, a reload — including
  // the hot reloads that happen while the app is being worked on — comes back with it still there.
  const param = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('rewind') : null;
  if (param === 'off') remember(false);
  const startsOpen = typeof window !== 'undefined' && param !== 'off' && (param !== null || rememberedOn());
  const [visible, setVisible] = useState(startsOpen);
  const [everOpened, setEverOpened] = useState(startsOpen);
  useEffect(() => {
    if (startsOpen) remember(true);
  }, [startsOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.code === 'KeyR') {
        e.preventDefault();
        setVisible(v => {
          if (!v) setEverOpened(true);
          remember(!v);
          return !v;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return {
    visible,
    everOpened,
    show: () => {
      setEverOpened(true);
      setVisible(true);
      remember(true);
    },
    // Hiding the strip keeps rewind switched ON — the handle stays, and a reload brings the strip
    // back. Switching it off entirely is what `?rewind=off` is for.
    hide: () => setVisible(false)
  };
}

/** The way back in, once the strip has been closed. Deliberately tiny and out of the way. */
export function RewindHandle({ onOpen }: { onOpen: () => void }) {
  return (
    <button className="baazi-rewind-handle" onClick={onOpen} aria-label="Show rewind" title="Rewind">
      ⟲
    </button>
  );
}
