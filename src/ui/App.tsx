import { useEffect, useState } from 'react';
import { TableView } from './TableView';
import { HUMAN_ID, OPPONENT_NAME, useBaaziGame } from './useBaaziGame';
import { useMultiplayerTable } from './useMultiplayerTable';
import type { MultiplayerTable } from './useMultiplayerTable';
import { expectedActor, seatRecord, turnLimitMs } from '../multiplayer/protocol';
import { codeFromUrl, inviteUrl } from '../multiplayer/session';
import { isSupabaseConfigured } from '../supabase';
import type { GameLengthConfig } from '../engine/roundOrchestrator';

type Route =
  | { at: 'home' }
  | { at: 'practice-length' }
  | { at: 'family' }
  | { at: 'practice'; config: GameLengthConfig }
  | { at: 'shared' };

/**
 * Sitting down.
 *
 * Two doors: Practice puts you opposite Baazigar on this device, Family puts you at a table
 * somebody can actually join from their own. The Family path is deliberately the shortest thing
 * that works — make a table, read the code out, they type it in — because the person joining
 * should need to know nothing except four characters.
 *
 * The shared-table hook lives here, at the top, so the table you make on one screen is the same
 * table you are sitting at on the next one.
 */
export default function App() {
  // A link with a code in it should land on the join screen, not the front door.
  const [route, setRoute] = useState<Route>(() => (codeFromUrl() ? { at: 'family' } : { at: 'home' }));
  const shared = useMultiplayerTable();

  // Whenever the shared hook actually seats us, that's the table screen — whether we got there by
  // creating, joining, or walking back in after a reload.
  useEffect(() => {
    if (shared.phase === 'at-table') setRoute({ at: 'shared' });
  }, [shared.phase]);

  if (route.at === 'shared') {
    return <SharedGame table={shared} onLeave={() => { shared.leave(); setRoute({ at: 'home' }); }} />;
  }
  if (route.at === 'practice') {
    return <PracticeGame config={route.config} onLeave={() => setRoute({ at: 'home' })} />;
  }
  if (route.at === 'family') {
    return <FamilyDoor table={shared} onBack={() => setRoute({ at: 'home' })} />;
  }
  if (route.at === 'practice-length') {
    return <PracticeLength onBack={() => setRoute({ at: 'home' })} onStart={config => setRoute({ at: 'practice', config })} />;
  }

  return (
    <Shell>
      <h1>Baazi</h1>
      <p className="baazi-subtitle">A quiet game of Seep.</p>
      <div className="baazi-seat-choice">
        <button onClick={() => setRoute({ at: 'family' })}>
          <span className="baazi-seat-name">Family</span>
          <span className="baazi-seat-detail">Play with family and friends.</span>
        </button>
        <button onClick={() => setRoute({ at: 'practice-length' })}>
          <span className="baazi-seat-name">Practice</span>
          <span className="baazi-seat-detail">Play with {OPPONENT_NAME}.</span>
        </button>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="baazi-app baazi-new-game">
      <div className="baazi-new-game-card">{children}</div>
    </div>
  );
}

function PracticeLength({ onBack, onStart }: { onBack: () => void; onStart: (config: GameLengthConfig) => void }) {
  const [pickingRounds, setPickingRounds] = useState(false);
  const [rounds, setRounds] = useState(1);

  return (
    <Shell>
      <button className="baazi-back-link" onClick={onBack}>
        ← Practice
      </button>
      <h1>How do you want to play?</h1>
      {!pickingRounds ? (
        <div className="baazi-seat-choice">
          <button onClick={() => onStart({ type: 'leadTarget', points: 100 })}>
            <span className="baazi-seat-name">100 Points</span>
            <span className="baazi-seat-detail">Play until someone leads by 100, counted after a completed round.</span>
          </button>
          <button onClick={() => setPickingRounds(true)}>
            <span className="baazi-seat-name">Rounds</span>
            <span className="baazi-seat-detail">Play a fixed number of rounds.</span>
          </button>
        </div>
      ) : (
        <>
          <label className="baazi-number-field">
            Rounds
            <input
              type="number"
              min={1}
              max={21}
              value={rounds}
              onChange={e => setRounds(Math.max(1, Number(e.target.value) || 1))}
            />
          </label>
          <button className="baazi-primary-button" onClick={() => onStart({ type: 'fixedRounds', rounds })}>
            Start game
          </button>
        </>
      )}
    </Shell>
  );
}

/**
 * Make a table, or walk into one. Nothing here mentions a room, a session, a database or an
 * account — the whole idea is that somebody can be told four characters and be sitting down a
 * moment later.
 */
function FamilyDoor({ table, onBack }: { table: MultiplayerTable; onBack: () => void }) {
  const [mode, setMode] = useState<'choose' | 'join'>(table.suggestedCode ? 'join' : 'choose');
  const [code, setCode] = useState(table.suggestedCode ?? '');
  const [name, setName] = useState('');
  const busy = table.phase === 'creating' || table.phase === 'joining';

  // A deploy without Supabase configured can still play Practice; it just can't share a table.
  // Saying so plainly beats a button that fails when pressed.
  if (!isSupabaseConfigured) {
    return (
      <Shell>
        <button className="baazi-back-link" onClick={onBack}>
          ← Baazi
        </button>
        <h1>Family</h1>
        <p className="baazi-subtitle">
          Shared games aren’t available on this build. Practice still works.
        </p>
      </Shell>
    );
  }

  if (mode === 'join') {
    return (
      <Shell>
        <button className="baazi-back-link" onClick={() => setMode('choose')}>
          ← Family
        </button>
        <h1>Join a game</h1>
        <p className="baazi-subtitle">Type the code you were given.</p>
        <input
          className="baazi-code-input"
          value={code}
          onChange={e => setCode(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && void table.join(code, name || undefined)}
          placeholder="K7QM"
          maxLength={4}
          autoFocus
          aria-label="Game code"
        />
        <input
          className="baazi-name-input"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Your name (optional)"
          aria-label="Your name"
        />
        {table.error && <p className="baazi-form-error">{table.error}</p>}
        <button className="baazi-primary-button" onClick={() => void table.join(code, name || undefined)} disabled={busy}>
          {table.phase === 'joining' ? 'Joining…' : 'Join game'}
        </button>
      </Shell>
    );
  }

  return (
    <Shell>
      <button className="baazi-back-link" onClick={onBack}>
        ← Baazi
      </button>
      <h1>Family</h1>
      <p className="baazi-subtitle">One of you makes the table, the other types the code.</p>
      <input
        className="baazi-name-input"
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="Your name (optional)"
        aria-label="Your name"
      />
      {table.error && <p className="baazi-form-error">{table.error}</p>}
      <div className="baazi-seat-choice">
        {/* Two ways to make a table, because they are genuinely different games: four chairs is the
            partnership game, two is head to head with twelve cards each and a reserve. Whoever
            hasn't arrived by the time the host starts is played by the computer, either way. */}
        <button onClick={() => void table.create(name || undefined, 4)} disabled={busy}>
          <span className="baazi-seat-name">
            {table.phase === 'creating' ? 'Making the table…' : 'Create game — four players'}
          </span>
          <span className="baazi-seat-detail">Two against two. You get a code to read out.</span>
        </button>
        <button onClick={() => void table.create(name || undefined, 2)} disabled={busy}>
          <span className="baazi-seat-name">
            {table.phase === 'creating' ? 'Making the table…' : 'Create game — two players'}
          </span>
          <span className="baazi-seat-detail">Head to head, twelve cards each.</span>
        </button>
        <button onClick={() => setMode('join')}>
          <span className="baazi-seat-name">Join game</span>
          <span className="baazi-seat-detail">Someone already gave you a code.</span>
        </button>
      </div>
    </Shell>
  );
}

function PracticeGame({ config, onLeave }: { config: GameLengthConfig; onLeave: () => void }) {
  const g = useBaaziGame();
  const { startNewGame } = g;

  useEffect(() => {
    startNewGame(config, 'practice');
    // Deliberately once, on entering this route — re-dealing on every render would be a new game
    // every frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!g.game) return null;

  return (
    <TableView
      game={g.game}
      mySeat={HUMAN_ID}
      thinkingPlayerId={g.thinkingPlayerId}
      canAct
      onBid={g.submitHumanBid}
      onOpeningAction={g.submitHumanOpeningAction}
      onMove={g.submitHumanMove}
      roundComplete={g.isRoundComplete}
      lastRoundResult={g.lastRoundResult}
      lastRoundScores={g.lastRoundScores}
      onFinishRound={g.finishRound}
      onNextRound={g.lastRoundResult?.gameOver ? onLeave : g.startNextRoundClicked}
    />
  );
}

/**
 * A table two people are sitting at.
 *
 * Everything the multiplayer layer does is meant to be invisible from here: once both people are
 * seated this renders the same Table component Practice does, from the same engine state. The only
 * visible differences are the code while you're waiting, and that the move buttons aren't offered
 * while the table is waiting on somebody else.
 */
function SharedGame({ table, onLeave }: { table: MultiplayerTable; onLeave: () => void }) {
  const envelope = table.envelope;

  if (!envelope) {
    return (
      <Shell>
        <h1>Baazi</h1>
        <p className="baazi-subtitle">That table isn’t open any more.</p>
        <button className="baazi-primary-button" onClick={onLeave}>
          Back
        </button>
      </Shell>
    );
  }

  if (!envelope.game) return <WaitingRoom table={table} onLeave={onLeave} />;

  const actor = expectedActor(envelope);
  const thinking = actor && seatRecord(envelope, actor)?.kind === 'ai' ? actor : null;

  return (
    <TableView
      game={envelope.game}
      mySeat={table.mySeat ?? HUMAN_ID}
      thinkingPlayerId={thinking}
      canAct={table.isMyTurn}
      onBid={table.submitBid}
      onOpeningAction={table.submitOpeningAction}
      onMove={table.submitMove}
      roundComplete={false}
      lastRoundResult={envelope.lastResult}
      lastRoundScores={envelope.lastRoundScores ?? null}
      onNextRound={table.dealNext ?? undefined}
      onLeave={onLeave}
      tableCode={envelope.code}
      turnStartedAt={envelope.turnStartedAt || undefined}
      turnLimitMs={actor ? turnLimitMs(envelope, actor) : undefined}
      notice={
        table.error ? (
          <div className="baazi-interlude baazi-interlude-quiet">
            <p>{table.error}</p>
          </div>
        ) : undefined
      }
    />
  );
}

/** The code, who has turned up, and the one button that starts it. */
function WaitingRoom({ table, onLeave }: { table: MultiplayerTable; onLeave: () => void }) {
  const code = table.envelope!.code;
  const seats = table.envelope!.seats;
  const here = seats.filter(s => s.sessionId !== null);
  const waiting = seats.length - here.length;
  const [copied, setCopied] = useState(false);
  // navigator.share only exists on devices that can actually hand this to another app — a phone's
  // share sheet, straight into Messages or WhatsApp. On a desktop browser it usually doesn't, so
  // copying stays the thing that always works rather than the thing you fall back to.
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const share = async () => {
    const url = inviteUrl(code);
    try {
      await navigator.share({ title: 'Baazi', text: `Join my Baazi game — code ${code}`, url });
    } catch {
      /* dismissed the share sheet, or it refused — nothing to report, the code is still on screen */
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl(code));
      setCopied(true);
    } catch {
      /* clipboard blocked — the code is on screen to read out, which is the point of it */
    }
  };

  return (
    <div className="baazi-app baazi-blanket baazi-waiting">
      <div className="baazi-waiting-card">
        <span className="baazi-waiting-label">Your game code</span>
        <span className="baazi-waiting-code">{code}</span>
        <ul className="baazi-waiting-seats">
          {seats.map(seat => (
            <li key={seat.seat} className={seat.sessionId ? 'is-here' : ''}>
              {seat.sessionId ? (seat.seat === table.mySeat ? `${seat.name} (you)` : seat.name) : 'Empty seat'}
            </li>
          ))}
        </ul>

        <span className="baazi-waiting-note">
          {waiting === 0
            ? 'Everyone’s here — dealing…'
            : `${here.length} of ${seats.length} here. Share the code, or start now and the rest are played by the computer.`}
        </span>

        {table.startNow && waiting > 0 && (
          <button className="baazi-primary-button baazi-waiting-start" onClick={table.startNow}>
            Start with {here.length}
          </button>
        )}
        <div className="baazi-waiting-actions">
          {canShare && (
            <button className="baazi-waiting-link is-primary" onClick={() => void share()}>
              Share link
            </button>
          )}
          <button className="baazi-waiting-link" onClick={() => void copy()}>
            {copied ? 'Link copied' : 'Copy link'}
          </button>
        </div>
        <button className="baazi-back-link baazi-waiting-leave" onClick={onLeave}>
          ← Leave
        </button>
      </div>
    </div>
  );
}
