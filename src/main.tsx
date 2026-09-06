import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { supabase } from './supabase';
import { breakHouse, buildHouse, call, capture, cementHouse, dealGame, drop, emptyState, rankValue, teamIdFor } from './game';
import { playBot } from './bot';
import type { BotLevel, Card, FloorItem, GameState, House, Player } from './game';
import './styles.css';

const id = () => crypto.randomUUID();
const roomFromUrl = () => new URLSearchParams(location.search).get('room')?.toUpperCase() || '';
const cardLabel = (card: Card) => `${card.rank}${card.suit}`;
const isRed = (card: Card) => card.suit === '♥' || card.suit === '♦';
const isHouse = (item: FloorItem): item is House => 'kind' in item && item.kind === 'house';
const itemLabel = (item: FloorItem) => isHouse(item) ? String(item.value) : cardLabel(item);
const requestMessage = (error: unknown) => {
  if (error instanceof TypeError && /fetch|network/i.test(error.message)) {
    return "Can't reach the table. Check your connection and try again.";
  }
  return error instanceof Error ? error.message : 'That move needs a second try.';
};
const databaseMessage = (message: string) => /invalid api key/i.test(message)
  ? 'The table connection needs a fresh key — check Supabase settings.'
  : message;

// Stable per-card jitter so the floor looks hand-scattered instead of gridded, without
// re-randomizing on every render.
function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
function scatter(id: string) {
  const h = hash(id);
  const rotate = ((h % 1200) / 100) - 6; // -6..6deg
  const drift = (((h >> 8) % 800) / 100) - 4; // -4..4px
  return { rotate, drift };
}

// "Combine" covers every way a card can join the floor into a house: start a new one, add to
// an existing one at the same value, or break one into a higher value.
function attemptCombine(state: GameState, playerId: string, cardId: string, floorIds: string[]): GameState {
  const errors: string[] = [];
  const tryOne = (fn: () => GameState) => { try { return fn(); } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); return null; } };
  let result = tryOne(() => buildHouse(state, playerId, cardId, floorIds));
  if (result) return result;
  const selectedItems = floorIds.map(fid => state.floor.find(item => item.id === fid)).filter((x): x is FloorItem => !!x);
  const houseSel = selectedItems.filter(isHouse);
  if (houseSel.length === 1) {
    const looseIds = floorIds.filter(fid => fid !== houseSel[0].id);
    result = tryOne(() => cementHouse(state, playerId, cardId, houseSel[0].id, looseIds));
    if (result) return result;
    result = tryOne(() => breakHouse(state, playerId, cardId, houseSel[0].id));
    if (result) return result;
  }
  throw new Error(errors[0] || 'That combination is not a legal house play.');
}

// Tries the player's most likely intent given what's selected: capture first, then a house
// action, falling back to a plain throw. Powers the swipe gesture; the three buttons call the
// specific actions directly for when someone wants to be deliberate about it.
function smartPlay(state: GameState, playerId: string, cardId: string, floorIds: string[]): GameState {
  if (floorIds.length === 0) return drop(state, playerId, cardId);
  const errors: string[] = [];
  const tryOne = (fn: () => GameState) => { try { return fn(); } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); return null; } };
  let result = tryOne(() => capture(state, playerId, cardId, floorIds));
  if (result) return result;
  result = tryOne(() => attemptCombine(state, playerId, cardId, floorIds));
  if (result) return result;
  throw new Error(errors[0] || 'That combination is not a legal play.');
}

function SwipeCard({ label, red, selected, disabled, onTap, onSwipeUp }: {
  label: string; red: boolean; selected: boolean; disabled: boolean; onTap: () => void; onSwipeUp: () => void;
}) {
  const [drag, setDrag] = useState({ x: 0, y: 0, active: false });
  const start = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);

  function down(e: React.PointerEvent) {
    if (disabled) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, y: e.clientY };
    moved.current = false;
    setDrag({ x: 0, y: 0, active: true });
  }
  function move(e: React.PointerEvent) {
    if (!start.current) return;
    const dx = e.clientX - start.current.x;
    const dy = Math.min(0, e.clientY - start.current.y); // only lift, don't push into the hand
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved.current = true;
    setDrag({ x: dx, y: dy, active: true });
  }
  function up() {
    const wasSwipe = drag.y < -70;
    start.current = null;
    setDrag({ x: 0, y: 0, active: false });
    if (wasSwipe) onSwipeUp();
    else if (!moved.current) onTap();
  }

  return (
    <button
      className={`swipe-card${red ? ' is-red' : ''}${selected ? ' is-selected' : ''}${disabled ? ' is-disabled' : ''}`}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      style={{
        transform: `translate(${drag.x}px, ${drag.y}px) rotate(${drag.x / 14}deg)`,
        transition: drag.active ? 'none' : 'transform 260ms cubic-bezier(.22,.9,.3,1)',
        opacity: Math.max(0.35, 1 + drag.y / 220)
      }}
    >{label}</button>
  );
}

function App() {
  const [pid] = useState(() => sessionStorage.getItem('baazi-pid') || id());
  const [name, setName] = useState('');
  const [code, setCode] = useState(roomFromUrl());
  const [state, setState] = useState<GameState | null>(null);
  const [message, setMessage] = useState('');
  const [botCount, setBotCount] = useState(0);
  const [cardId, setCardId] = useState('');
  const [floorIds, setFloorIds] = useState<string[]>([]);
  useEffect(() => sessionStorage.setItem('baazi-pid', pid), [pid]);

  async function save(next: GameState) {
    const { error } = await supabase.from('baazi_rooms').update({ state: next }).eq('code', code);
    if (error) setMessage(error.message); else setState(next);
  }

  async function create() {
    try {
      const c = Math.random().toString(36).slice(2, 8).toUpperCase();
      const st: GameState = { ...emptyState(pid), players: [{ id: pid, name: name.trim() || 'Host' }] };
      const { error } = await supabase.from('baazi_rooms').insert({ code: c, state: st });
      if (error) return setMessage(databaseMessage(error.message));
      setCode(c); setState(st);
      history.replaceState({}, '', `?room=${c}`);
      setMessage('Send this link to your family.');
    } catch (error) { setMessage(requestMessage(error)); }
  }

  async function copyInvite() {
    try { await navigator.clipboard.writeText(location.href); setMessage('Link copied.'); }
    catch { setMessage('Copy the address bar and send it along.'); }
  }

  async function join() {
    try {
      if (!code) return setMessage('Enter the table code.');
      const { data, error } = await supabase.from('baazi_rooms').select('*').eq('code', code).single();
      if (error) return setMessage(databaseMessage(error.message));
      if (!data) return setMessage('No table with that code.');
      let next = data.state as GameState;
      if (!next.players.some(player => player.id === pid)) {
        if (next.phase !== 'waiting') return setMessage('This hand is already underway.');
        if (next.players.length >= 4) return setMessage('The table is full.');
        next = { ...next, players: [...next.players, { id: pid, name: name.trim() || `Player ${next.players.length + 1}` }] };
        const update = await supabase.from('baazi_rooms').update({ state: next }).eq('code', code);
        if (update.error) return setMessage(databaseMessage(update.error.message));
      }
      setState(next); history.replaceState({}, '', `?room=${code}`);
    } catch (error) { setMessage(requestMessage(error)); }
  }

  useEffect(() => {
    if (!code) return;
    const channel = supabase.channel(`room-${code}`).on('postgres_changes', { event: '*', schema: 'public', table: 'baazi_rooms', filter: `code=eq.${code}` }, event => {
      if (event.new) setState((event.new as { state: GameState }).state);
    }).subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [code]);

  useEffect(() => {
    if (!state || !state.turnPlayerId || (state.phase !== 'playing' && state.phase !== 'calling')) return;
    const player = state.players.find(item => item.id === state.turnPlayerId);
    if (!player?.bot) return;
    const timer = window.setTimeout(() => { try { save(playBot(state, player.id)); } catch { setMessage('The bot passed on a bad move.'); } }, 650);
    return () => window.clearTimeout(timer);
  }, [state?.moveNumber, state?.phase, state?.turnPlayerId]);

  const me = state?.players.find(player => player.id === pid);
  const hand = state?.hands[pid] || [];
  const isTurn = state?.phase === 'playing' && state.turnPlayerId === pid;
  const doMove = (fn: (current: GameState) => GameState) => {
    if (!state) return;
    try { save(fn(state)); setCardId(''); setFloorIds([]); }
    catch (error) { setMessage(error instanceof Error ? error.message : "That doesn't work here."); }
  };
  const toggleFloor = (itemId: string) => setFloorIds(ids => ids.includes(itemId) ? ids.filter(x => x !== itemId) : [...ids, itemId]);
  const addBots = (n: number) => {
    if (!state || state.hostPlayerId !== pid || state.phase !== 'waiting') return;
    const humans = state.players.filter(player => !player.bot);
    const bots: Player[] = Array.from({ length: Math.min(n, Math.max(0, 4 - humans.length)) }, (_, i) => ({ id: `bot-${i + 1}`, name: `Bot ${i + 1}`, bot: true, botLevel: 'Intermediate' as BotLevel }));
    setBotCount(n);
    doMove(current => ({ ...current, players: [...humans, ...bots] }));
  };

  // Selected hand card's rank, used to gently highlight floor cards it can capture on sight.
  const selectedCard = hand.find(c => c.id === cardId);
  const selectedValue = selectedCard ? rankValue(selectedCard.rank) : null;
  const obviousMatch = (item: FloorItem) => selectedValue != null && (isHouse(item) ? item.value === selectedValue : rankValue(item.rank) === selectedValue);

  // Running total for whatever's tapped on the floor — lets you build 7 + 1 + 5 and watch it add up.
  const selectedFloorObjs = state ? floorIds.map(fid => state.floor.find(item => item.id === fid)).filter((x): x is FloorItem => !!x) : [];
  const floorParts = selectedFloorObjs.map(item => isHouse(item) ? item.value : rankValue(item.rank));
  const sumParts = selectedValue != null ? [...floorParts, selectedValue] : floorParts;
  const sumTotal = sumParts.reduce((a, b) => a + b, 0);

  // Seat the table so "me" is always at the bottom, rotating the rest around counter-clockwise.
  const seatSlots = ['bottom', 'right', 'top', 'left'] as const;
  const seatOrder = state && me ? (() => {
    const startIndex = state.players.findIndex(p => p.id === pid);
    return state.players.map((_, i) => state.players[(startIndex + i) % state.players.length]);
  })() : [];

  if (!state) {
    return <main className="app-bg entry">
      <div className="entry-card">
        <p className="eyebrow">A table for the family</p>
        <h1>Baazi</h1>
        <input className="entry-input" aria-label="Your name" placeholder="Your name" value={name} onChange={e => setName(e.target.value)} />
        <button className="cta" onClick={create}>Set the table</button>
        <div className="entry-join">
          <input aria-label="Table code" placeholder="Table code" value={code} onChange={e => setCode(e.target.value.toUpperCase())} />
          <button className="ghost" onClick={join}>Join</button>
        </div>
        {message && <p className="toast">{message}</p>}
      </div>
    </main>;
  }

  return <main className="app-bg">
    <div className="table-scene">
      <div className="table-topbar">
        <span className="room-tag" onClick={copyInvite}>{code}</span>
        <span className="score-plaque">
          {Object.entries(state.scores).map(([team, score]) => `${team === (me ? teamIdFor(state.players, me.id) : '') ? 'You' : 'Them'} ${score}`).join('  ·  ')}
        </span>
      </div>

      {seatOrder.map((player, i) => (
        <div key={player.id} className={`seat seat-${seatSlots[i] || 'top'}${state.turnPlayerId === player.id ? ' is-turn' : ''}`}>
          <span className="seat-name">{player.name}</span>
        </div>
      ))}

      <div className="floor">
        {state.floorRevealed ? state.floor.map(item => {
          const { rotate, drift } = scatter(item.id);
          return (
            <button
              key={item.id}
              className={`floor-item${isHouse(item) ? ' is-house' : ''}${floorIds.includes(item.id) ? ' is-selected' : ''}${obviousMatch(item) ? ' is-hint' : ''}`}
              disabled={!isTurn}
              style={{ transform: `rotate(${rotate}deg) translateY(${drift}px)` }}
              onClick={() => toggleFloor(item.id)}
            >{itemLabel(item)}</button>
          );
        }) : <span className="floor-hidden">Floor hidden until the call</span>}
      </div>

      {state.floorRevealed && sumParts.length > 1 && (
        <div className="sum-readout">{sumParts.join(' + ')} = {sumTotal}</div>
      )}

      {state.phase === 'calling' && state.callerPlayerId === pid && (
        <div className="call-tray">
          <span className="call-hint">Call one</span>
          <div className="call-chips">
            {[9, 10, 11, 12, 13].map(v => (
              <button key={v} className="call-chip" onClick={() => doMove(current => call(current, pid, v))}>{v === 11 ? 'J' : v === 12 ? 'Q' : v === 13 ? 'K' : v}</button>
            ))}
          </div>
        </div>
      )}

      {state.phase === 'waiting' && state.hostPlayerId === pid && (
        <div className="setup-tray">
          <p className="setup-hint">{state.players.length} at the table</p>
          <div className="bot-dots">
            {[0, 1, 2, 3].map(n => <button key={n} className={`bot-dot${botCount === n ? ' is-active' : ''}`} onClick={() => addBots(n)}>{n === 0 ? 'No bots' : n}</button>)}
          </div>
          <button className="cta" disabled={state.players.length < 2} onClick={() => doMove(current => dealGame(current, Math.floor(Math.random() * 51) + 1))}>Deal</button>
        </div>
      )}

      {state.phase === 'handComplete' && state.hostPlayerId === pid && (
        <button className="cta cta-float" onClick={() => doMove(current => dealGame(current, Math.floor(Math.random() * 51) + 1))}>Next hand</button>
      )}

      {(message || state.message) && <p className="toast">{message || state.message}</p>}

      {isTurn && cardId && (
        <div className="action-bar">
          <button className="action-btn" disabled={!floorIds.length} onClick={() => doMove(current => capture(current, pid, cardId, floorIds))}>Collect</button>
          <button className="action-btn" onClick={() => doMove(current => attemptCombine(current, pid, cardId, floorIds))}>Combine</button>
          <button className="action-btn action-btn-throw" onClick={() => doMove(current => drop(current, pid, cardId))}>Throw</button>
        </div>
      )}

      <div className="hand">
        {hand.map(card => {
          const { rotate } = scatter(card.id);
          const fanAngle = rotate / 2;
          return (
            <div key={card.id} className="hand-slot" style={{ transform: `rotate(${fanAngle}deg)` }}>
              <SwipeCard
                label={cardLabel(card)}
                red={isRed(card)}
                selected={cardId === card.id}
                disabled={!isTurn}
                onTap={() => setCardId(current => current === card.id ? '' : card.id)}
                onSwipeUp={() => doMove(current => smartPlay(current, pid, card.id, floorIds))}
              />
            </div>
          );
        })}
      </div>

      {state.phase === 'gameOver' && <div className="game-over">Baazi.</div>}
    </div>
  </main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
