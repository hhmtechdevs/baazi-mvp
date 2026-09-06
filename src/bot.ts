import { buildHouse, call, capture, drop, rankValue } from './game';
import type { BotLevel, Card, FloorItem, GameState, House } from './game';

export type BotAction =
  | { kind: 'call'; value: number }
  | { kind: 'drop'; cardId: string }
  | { kind: 'build'; cardId: string; floorIds: string[] }
  | { kind: 'capture'; cardId: string; floorIds: string[] };

const isHouse = (item: FloorItem): item is House => 'kind' in item && item.kind === 'house';
const looseCards = (floor: FloorItem[]) => floor.filter(item => !isHouse(item)) as Card[];
const cardScore = (card: Card) => card.suit === '♠' ? rankValue(card.rank) : card.rank === '10' && card.suit === '♦' ? 6 : card.rank === 'A' ? 1 : 0;

// All non-empty subsets of a small array. Floors stay tiny (well under a dozen loose cards),
// so an exponential search here is cheap.
const combinations = <T>(items: T[]): T[][] =>
  items.reduce<T[][]>((all, item) => [...all, ...all.map(set => [...set, item])], [[]]).filter(set => set.length > 0);

const looseSubsetsSumming = (floor: FloorItem[], value: number) =>
  combinations(looseCards(floor)).filter(set => set.reduce((total, card) => total + rankValue(card.rank), 0) === value);

// The engine now requires taking everything a played card is entitled to — no leftover loose
// card or house of the same value. Build each candidate capture up to that full amount.
function bestCapture(state: GameState, hand: Card[]) {
  const results: { card: Card; targets: FloorItem[] }[] = [];
  for (const card of hand) {
    const value = rankValue(card.rank);
    const houseHere = state.floor.find(item => isHouse(item) && item.value === value) as House | undefined;
    const subsets = looseSubsetsSumming(state.floor, value);
    if (!subsets.length) {
      if (houseHere) results.push({ card, targets: [houseHere] });
      continue;
    }
    for (const subset of subsets) {
      const chosenIds = new Set(subset.map(c => c.id));
      const strayLoose = looseCards(state.floor).filter(c => !chosenIds.has(c.id) && rankValue(c.rank) === value);
      const targets: FloorItem[] = [...subset, ...strayLoose];
      if (houseHere) targets.push(houseHere);
      results.push({ card, targets });
    }
  }
  if (!results.length) return null;
  const scored = results.map(r => ({
    ...r,
    score: r.targets.flatMap(item => isHouse(item) ? item.cards : [item]).reduce((n, c) => n + cardScore(c), 0)
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// A house's value is the PLAYED card's rank plus whatever loose floor cards join it — not the
// played card's rank alone — and building requires holding a second matching card afterward.
function bestBuild(state: GameState, hand: Card[], requiredValue: number | null) {
  const loose = looseCards(state.floor);
  const subsets: Card[][] = [[], ...combinations(loose)];
  for (const card of hand) {
    for (const subset of subsets) {
      const value = rankValue(card.rank) + subset.reduce((sum, c) => sum + rankValue(c.rank), 0);
      if (value < 9 || value > 13) continue;
      if (requiredValue != null && value !== requiredValue) continue;
      const remaining = hand.filter(c => c.id !== card.id);
      if (!remaining.some(c => rankValue(c.rank) === value)) continue;
      return { card, floorIds: subset.map(c => c.id), value };
    }
  }
  return null;
}

export function chooseBotAction(state: GameState, playerId: string): BotAction {
  const player = state.players.find(item => item.id === playerId);
  const level: BotLevel = player?.botLevel || 'Beginner';
  const hand = state.hands[playerId] || [];
  // On the caller's very first move, everything played must use the called value.
  const forced = playerId === state.callerPlayerId && state.moveNumber === 0 ? state.forcedCardValue : null;

  if (state.phase === 'calling') {
    const options = hand.filter(card => rankValue(card.rank) >= 9 && rankValue(card.rank) <= 13).map(card => rankValue(card.rank));
    return { kind: 'call', value: options.length ? Math.max(...options) : 9 };
  }

  const captureHand = forced != null ? hand.filter(card => rankValue(card.rank) === forced) : hand;
  const captures = bestCapture(state, captureHand);
  if (captures && captures.length) {
    const choice = level === 'Beginner' ? captures[captures.length - 1] : captures[0];
    return { kind: 'capture', cardId: choice.card.id, floorIds: choice.targets.map(item => item.id) };
  }

  if (level !== 'Beginner') {
    const build = bestBuild(state, hand, forced);
    if (build) return { kind: 'build', cardId: build.card.id, floorIds: build.floorIds };
  }

  const throwHand = forced != null ? hand.filter(card => rankValue(card.rank) === forced) : hand;
  const pool = throwHand.length ? throwHand : hand;
  const ordered = [...pool].sort((a, b) => level === 'Expert' ? cardScore(a) - cardScore(b) : rankValue(a.rank) - rankValue(b.rank));
  return { kind: 'drop', cardId: ordered[0]?.id || hand[0]?.id || '' };
}

export function playBot(state: GameState, playerId: string): GameState {
  const action = chooseBotAction(state, playerId);
  if (action.kind === 'call') return call(state, playerId, action.value);
  if (action.kind === 'capture') return capture(state, playerId, action.cardId, action.floorIds);
  if (action.kind === 'build') return buildHouse(state, playerId, action.cardId, action.floorIds);
  return drop(state, playerId, action.cardId);
}
