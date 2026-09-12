import { describe, expect, it } from 'vitest';
import { executeMove, finalizeOpeningAndAdvance } from './moveExecution';
import { discoverLegalOptions } from './legalMoves';
import { assertCardInvariant } from './deal';
import { createDeck } from './deck';
import type { Card, GameState, House, Player, Team } from '../types';

function card(rank: Card['rank'], suit: Card['suit']): Card {
  return { id: `${rank}-${suit}`, rank, suit };
}

function makePlayer(id: string, hand: Card[], opts: { teamId?: string | null; reserve?: Card[]; captured?: Card[] } = {}): Player {
  return { id, name: id, teamId: opts.teamId ?? null, hand, reserve: opts.reserve ?? [], captured: opts.captured ?? [] };
}

/**
 * Builds a full, invariant-satisfying GameState: named players/floor cards are exactly what's
 * under test, and any remaining canonical deck cards are parked in `deck` (never in a player's
 * hand) so they never interfere with hand/reserve-based checks like final-play detection.
 *
 * `teams` defaults to [] — most tests don't exercise partnership behavior, and sideOf() falls
 * back to treating each player as their own side when no team entry exists for them, so this
 * default is safe. Tests that specifically exercise partner-key/joint-ownership rules pass
 * `teams` explicitly.
 */
function makeState(opts: {
  players: Player[];
  floorLoose?: Card[];
  floorHouses?: House[];
  currentPlayerIndex?: number;
  mode?: GameState['mode'];
  phase?: GameState['phase'];
  teams?: Team[];
  bidderId?: string | null;
  turnNumber?: number;
  history?: GameState['history'];
}): GameState {
  const floorLoose = opts.floorLoose ?? [];
  const floorHouses = opts.floorHouses ?? [];
  const used = new Set(
    [...opts.players.flatMap(p => [...p.hand, ...p.reserve, ...p.captured]), ...floorLoose, ...floorHouses.flatMap(h => h.cards)].map(
      c => c.id
    )
  );
  const deck = createDeck().filter(c => !used.has(c.id));
  return {
    gameId: 'g',
    mode: opts.mode ?? '4player',
    roundNumber: 1,
    players: opts.players,
    teams: opts.teams ?? [],
    floor: { loose: floorLoose, houses: floorHouses },
    deck,
    phase: opts.phase ?? 'playing',
    currentPlayerIndex: opts.currentPlayerIndex ?? 0,
    turnNumber: opts.turnNumber ?? 0,
    bidValue: null,
    bidderId: opts.bidderId ?? null,
    sweepRecords: [],
    scores: {},
    roundScores: {},
    history: opts.history ?? []
  };
}

describe('builds (1-6)', () => {
  it('creates a new ordinary house with correct movement, retention, owner, and value', () => {
    const six = card('6', 'hearts');
    const j = card('J', 'clubs');
    const state = makeState({
      players: [makePlayer('p1', [six, j]), makePlayer('p2', [])],
      floorLoose: [card('2', 'clubs'), card('3', 'diamonds')]
    });
    const next = executeMove(state, 'p1', { kind: 'build', handCardId: six.id, floorCardIds: ['2-clubs', '3-diamonds'], absorbedLooseCardIds: [] });
    const house = next.floor.houses[0];
    expect(house.captureValue).toBe(11);
    expect(next.players.find(p => p.id === 'p1')!.hand.some(c => c.id === six.id)).toBe(false);
    expect(next.floor.loose).toHaveLength(0);
    expect(next.players.find(p => p.id === 'p1')!.hand.some(c => c.id === j.id)).toBe(true);
    expect(house.ownerSides).toEqual(['p1']);
    assertCardInvariant(next);
  });
});

describe('breaking (7-15)', () => {
  it('breaks an opponent house, transfers ownership, sets new value, retains new key', () => {
    const two = card('2', 'spades');
    const jack = card('J', 'diamonds');
    const existingHouse: House = { id: 'house-A', ownerSides: ['p2'], cards: [card('9', 'clubs')], captureValue: 9, isCemented: false };
    const state = makeState({ players: [makePlayer('p1', [two, jack]), makePlayer('p2', [])], floorHouses: [existingHouse] });
    const next = executeMove(state, 'p1', { kind: 'break', handCardId: two.id, existingHouseId: 'house-A', absorbedLooseCardIds: [] });
    const broken = next.floor.houses.find(h => h.captureValue === 11)!;
    expect(broken).toBeDefined();
    expect(broken.ownerSides).toEqual(['p1']);
    expect(next.players.find(p => p.id === 'p1')!.hand.some(c => c.id === jack.id)).toBe(true);
    assertCardInvariant(next);
  });

  it('breaks a partner house — individual ownership, not side-restricted (frozen: "a player may break their partner\'s ordinary house")', () => {
    const two = card('2', 'spades');
    const jack = card('J', 'diamonds');
    const existingHouse: House = { id: 'house-A', ownerSides: ['p2'], cards: [card('9', 'clubs')], captureValue: 9, isCemented: false };
    const state = makeState({
      players: [makePlayer('p1', [two, jack], { teamId: 'team-0' }), makePlayer('p2', [], { teamId: 'team-0' })],
      floorHouses: [existingHouse],
      teams: [{ id: 'team-0', name: 'Team 0', playerIds: ['p1', 'p2'] }]
    });
    const next = executeMove(state, 'p1', { kind: 'break', handCardId: two.id, existingHouseId: 'house-A', absorbedLooseCardIds: [] });
    const broken = next.floor.houses.find(h => h.captureValue === 11);
    expect(broken).toBeDefined();
    expect(broken!.ownerSides).toEqual(['p1']); // breaking transfers sole ownership to the individual, even for a partner's house
  });

  it('rejects breaking your own house', () => {
    const two = card('2', 'spades');
    const ownHouse: House = { id: 'house-A', ownerSides: ['p1'], cards: [card('9', 'clubs')], captureValue: 9, isCemented: false };
    const state = makeState({ players: [makePlayer('p1', [two, card('J', 'hearts')]), makePlayer('p2', [])], floorHouses: [ownHouse] });
    // The specific reason ("own house") now lives in discovery, which simply omits the option
    // rather than throwing a descriptive message — execution's error is deliberately generic.
    expect(() => executeMove(state, 'p1', { kind: 'break', handCardId: two.id, existingHouseId: 'house-A', absorbedLooseCardIds: [] })).toThrow(/not currently legal/);
  });

  it('rejects breaking a cemented house', () => {
    const two = card('2', 'spades');
    const cemented: House = {
      id: 'house-A',
      ownerSides: ['p2'],
      cards: [card('9', 'clubs'), card('4', 'diamonds'), card('5', 'clubs')],
      captureValue: 9,
      isCemented: true
    };
    const state = makeState({ players: [makePlayer('p1', [two, card('J', 'hearts')]), makePlayer('p2', [])], floorHouses: [cemented] });
    expect(() => executeMove(state, 'p1', { kind: 'break', handCardId: two.id, existingHouseId: 'house-A', absorbedLooseCardIds: [] })).toThrow(/not currently legal/);
  });

  it('rejects referencing a loose card id as the house to break', () => {
    const houseA: House = { id: 'house-A', ownerSides: ['p2'], cards: [card('9', 'clubs')], captureValue: 9, isCemented: false };
    const state = makeState({
      players: [makePlayer('p1', [card('2', 'spades'), card('J', 'hearts')]), makePlayer('p2', [])],
      floorLoose: [card('4', 'diamonds')],
      floorHouses: [houseA]
    });
    expect(() => executeMove(state, 'p1', { kind: 'break', handCardId: '2-spades', existingHouseId: '4-diamonds', absorbedLooseCardIds: [] })).toThrow(
      /not currently legal/
    );
  });
});

describe('cementing (16-20)', () => {
  it('16. matching card added to an existing house cements it (9+3, +Q)', () => {
    const q = card('Q', 'hearts');
    const qSpare = card('Q', 'spades'); // retained per Ingredient 4's uniform retention rule
    const existing: House = { id: 'house-A', ownerSides: ['p2'], cards: [card('9', 'clubs'), card('3', 'diamonds')], captureValue: 12, isCemented: false };
    // 2-player mode: sideOf() resolves each player to themselves without needing state.teams,
    // which is the honest characterization here — no partnership is under test.
    const state = makeState({ players: [makePlayer('p1', [q, qSpare]), makePlayer('p2', [])], floorHouses: [existing], mode: '2player' });
    const next = executeMove(state, 'p1', { kind: 'cement', handCardId: q.id, floorCardIds: [], existingHouseId: 'house-A', absorbedLooseCardIds: [] });
    const merged = next.floor.houses.find(h => h.id === 'house-A')!;
    expect(merged.isCemented).toBe(true);
    expect(merged.captureValue).toBe(12);
    expect(merged.ownerSides.sort()).toEqual(['p1', 'p2']); // cross-side cement -> joint ownership (in 2-player mode, each player is their own side)
    assertCardInvariant(next);
  });

  it('17. a second numerical combination cements an existing house (9+3, +6+6, no Queen needed)', () => {
    const six = card('6', 'hearts');
    const existing: House = { id: 'house-A', ownerSides: ['p2'], cards: [card('9', 'clubs'), card('3', 'diamonds')], captureValue: 12, isCemented: false };
    const state = makeState({
      players: [makePlayer('p1', [six, card('Q', 'spades')]), makePlayer('p2', [])],
      floorLoose: [card('6', 'clubs')],
      floorHouses: [existing],
      mode: '2player'
    });
    const next = executeMove(state, 'p1', { kind: 'cement', handCardId: six.id, floorCardIds: ['6-clubs'], existingHouseId: 'house-A', absorbedLooseCardIds: [] });
    const merged = next.floor.houses.find(h => h.id === 'house-A')!;
    expect(merged.isCemented).toBe(true);
    expect(merged.captureValue).toBe(12);
    assertCardInvariant(next);
  });

  it('18. a loose matching card is absorbed when a new combination is built at its value', () => {
    const five = card('5', 'hearts');
    const q = card('Q', 'clubs');
    const state = makeState({
      players: [makePlayer('p1', [five, q]), makePlayer('p2', [])],
      floorLoose: [card('Q', 'diamonds'), card('7', 'spades')]
    });
    const next = executeMove(state, 'p1', { kind: 'build', handCardId: five.id, floorCardIds: ['7-spades'], absorbedLooseCardIds: ['Q-diamonds'] });
    expect(next.floor.houses).toHaveLength(1); // no duplicate House objects
    const house = next.floor.houses[0];
    expect(house.isCemented).toBe(true);
    expect(house.captureValue).toBe(12);
    assertCardInvariant(next);
  });

  it('19. captureValue is unchanged by cementing', () => {
    const q = card('Q', 'hearts');
    const qSpare = card('Q', 'spades');
    const existing: House = { id: 'house-A', ownerSides: ['p2'], cards: [card('9', 'clubs'), card('3', 'diamonds')], captureValue: 12, isCemented: false };
    const state = makeState({ players: [makePlayer('p1', [q, qSpare]), makePlayer('p2', [])], floorHouses: [existing], mode: '2player' });
    const next = executeMove(state, 'p1', { kind: 'cement', handCardId: q.id, floorCardIds: [], existingHouseId: 'house-A', absorbedLooseCardIds: [] });
    expect(next.floor.houses.find(h => h.id === 'house-A')!.captureValue).toBe(12);
    assertCardInvariant(next);
  });

  it('20. a cemented house cannot subsequently be broken', () => {
    const cemented: House = {
      id: 'house-A',
      ownerSides: ['p1', 'p2'],
      cards: [card('9', 'clubs'), card('3', 'diamonds'), card('Q', 'hearts')],
      captureValue: 12,
      isCemented: true
    };
    const state = makeState({
      players: [makePlayer('p1', [card('A', 'spades'), card('K', 'hearts')]), makePlayer('p2', [])],
      floorHouses: [cemented]
    });
    expect(() => executeMove(state, 'p1', { kind: 'break', handCardId: 'A-spades', existingHouseId: 'house-A', absorbedLooseCardIds: [] })).toThrow(
      /not currently legal/
    );
  });
});

describe('captures (21-26)', () => {
  it('21/25/26. normal loose-card capture moves exactly the right cards', () => {
    const four = card('4', 'spades');
    const state = makeState({ players: [makePlayer('p1', [four]), makePlayer('p2', [])], floorLoose: [card('4', 'clubs')] });
    const next = executeMove(state, 'p1', { kind: 'capture', handCardId: four.id, targets: [{ type: 'loose', cardId: '4-clubs' }] });
    const bidder = next.players.find(p => p.id === 'p1')!;
    expect(bidder.captured.some(c => c.id === '4-clubs')).toBe(true);
    expect(next.floor.loose).toHaveLength(0);
    expect(bidder.captured).toHaveLength(2);
  });

  it('22. capturing a matching house moves all its cards and removes it from the floor', () => {
    const j = card('J', 'hearts');
    const house: House = { id: 'house-A', ownerSides: ['p2'], cards: [card('6', 'clubs'), card('5', 'diamonds')], captureValue: 11, isCemented: false };
    const state = makeState({ players: [makePlayer('p1', [j]), makePlayer('p2', [])], floorHouses: [house], mode: '2player' });
    const next = executeMove(state, 'p1', { kind: 'capture', handCardId: j.id, targets: [{ type: 'house', houseId: 'house-A' }] });
    expect(next.floor.houses).toHaveLength(0);
    expect(next.players.find(p => p.id === 'p1')!.captured).toHaveLength(3);
  });

  it('23/24. a house combines with an independent loose capture, never used as loose arithmetic', () => {
    const j = card('J', 'hearts');
    const house: House = { id: 'house-B', ownerSides: ['p2'], cards: [card('6', 'diamonds'), card('5', 'spades')], captureValue: 11, isCemented: false };
    const state = makeState({
      players: [makePlayer('p1', [j]), makePlayer('p2', [])],
      floorLoose: [card('7', 'clubs'), card('4', 'diamonds')],
      floorHouses: [house],
      mode: '2player'
    });
    const next = executeMove(state, 'p1', {
      kind: 'capture',
      handCardId: j.id,
      targets: [{ type: 'house', houseId: 'house-B' }, { type: 'loose', cardId: '7-clubs' }, { type: 'loose', cardId: '4-diamonds' }]
    });
    expect(next.floor.houses).toHaveLength(0);
    expect(next.floor.loose).toHaveLength(0);
    assertCardInvariant(next);
  });

  it('overlapping capture alternatives (pagat 2+3+6 vs 5+6): choosing one executes it and leaves the unchosen cards on the floor', () => {
    const j = card('J', 'hearts');
    // p2 needs a placeholder card so this capture isn't ALSO the literal last card of the round —
    // otherwise Ingredient 6's end-of-play detection would (correctly) sweep the unchosen
    // alternative's cards to the capturer too, which isn't what this test is demonstrating.
    const state = makeState({
      players: [makePlayer('p1', [j]), makePlayer('p2', [card('K', 'clubs')])],
      floorLoose: [card('2', 'clubs'), card('3', 'diamonds'), card('5', 'spades'), card('6', 'hearts')],
      mode: '2player'
    });
    const options = discoverLegalOptions(state, 'p1', j.id).filter(
      (o): o is Extract<typeof o, { kind: 'capture' }> => o.kind === 'capture'
    );
    expect(options).toHaveLength(2);
    const chosen = options.find(o => o.targets.length === 2)!; // the {5,6} alternative
    const next = executeMove(state, 'p1', { kind: 'capture', handCardId: j.id, targets: chosen.targets });
    const captured = next.players.find(p => p.id === 'p1')!.captured.map(c => c.id).sort();
    expect(captured).toEqual(['5-spades', '6-hearts', 'J-hearts'].sort());
    expect(next.floor.loose.map(c => c.id).sort()).toEqual(['2-clubs', '3-diamonds']); // the unchosen 2+3+6 alternative's cards remain
    assertCardInvariant(next);
  });

  it('a house cannot be treated as a numerical card inside a loose-card sum (J + 9-house + 2 must NOT be an 11-value capture)', () => {
    const j = card('J', 'hearts'); // value 11
    const house: House = { id: 'house-9', ownerSides: ['p2'], cards: [card('9', 'clubs')], captureValue: 9, isCemented: false };
    const state = makeState({
      players: [makePlayer('p1', [j]), makePlayer('p2', [])],
      floorLoose: [card('2', 'spades')], // 9 (house) + 2 (loose) = 11, but must never be combined arithmetically
      floorHouses: [house],
      mode: '2player'
    });
    const options = discoverLegalOptions(state, 'p1', j.id);
    expect(options.some(o => o.kind === 'capture')).toBe(false); // no 9-house, no 2-alone, no 11-combo exists
    expect(() =>
      executeMove(state, 'p1', { kind: 'capture', handCardId: j.id, targets: [{ type: 'house', houseId: 'house-9' }, { type: 'loose', cardId: '2-spades' }] })
    ).toThrow(/not currently legal/);
  });
});

describe('throws (27-29)', () => {
  it('27/28. throw moves the card to loose floor and never touches houses', () => {
    const four = card('4', 'spades');
    const state = makeState({ players: [makePlayer('p1', [four]), makePlayer('p2', [])] });
    const next = executeMove(state, 'p1', { kind: 'throw', handCardId: four.id });
    expect(next.floor.loose.some(c => c.id === '4-spades')).toBe(true);
    expect(next.floor.houses).toHaveLength(0);
  });

  it('29. throw is rejected when a capture exists (mandatory capture)', () => {
    const four = card('4', 'spades');
    const state = makeState({ players: [makePlayer('p1', [four]), makePlayer('p2', [])], floorLoose: [card('4', 'clubs')] });
    expect(() => executeMove(state, 'p1', { kind: 'throw', handCardId: four.id })).toThrow(/not currently legal/);
  });
});

describe('sweeps (30-34)', () => {
  it('30/32/34. a capture that empties the floor records a normal sweep with no extra turn', () => {
    const four = card('4', 'spades');
    // p2 needs a placeholder card — otherwise both hands are empty right after p1's capture and
    // Ingredient 6 correctly treats that as genuine end-of-play rather than "advance to p2".
    const state = makeState({ players: [makePlayer('p1', [four]), makePlayer('p2', [card('K', 'clubs')])], floorLoose: [card('4', 'clubs')] });
    const next = executeMove(state, 'p1', { kind: 'capture', handCardId: four.id, targets: [{ type: 'loose', cardId: '4-clubs' }] });
    expect(next.sweepRecords).toHaveLength(1);
    expect(next.sweepRecords[0].isOpeningPlay).toBe(false);
    expect(next.currentPlayerIndex).toBe(1);
  });

  it('31. an opening sweep is marked correctly via finalizeOpeningAndAdvance', () => {
    const state = makeState({
      players: [makePlayer('p1', []), makePlayer('p2', [])],
      floorLoose: [],
      phase: 'opening',
      currentPlayerIndex: 0,
      bidderId: 'p1'
    });
    const next = finalizeOpeningAndAdvance(state, 'p1', true);
    expect(next.sweepRecords).toHaveLength(1);
    expect(next.sweepRecords[0].isOpeningPlay).toBe(true);
  });

  it('33. the literal last card of the round is marked as a final-play sweep', () => {
    const four = card('4', 'spades');
    const fourClubs = card('4', 'clubs');
    const used = new Set([four, fourClubs].map(c => c.id));
    const deck = createDeck().filter(c => !used.has(c.id)); // leftover cards go to deck, never a hand
    const state: GameState = {
      gameId: 'g',
      mode: '4player',
      roundNumber: 1,
      players: [makePlayer('p1', [four]), makePlayer('p2', [])],
      teams: [],
      floor: { loose: [fourClubs], houses: [] },
      deck,
      phase: 'playing',
      currentPlayerIndex: 0,
      turnNumber: 0,
      bidValue: null,
      bidderId: null,
      sweepRecords: [],
      scores: {},
      roundScores: {},
      history: []
    };
    const next = executeMove(state, 'p1', { kind: 'capture', handCardId: four.id, targets: [{ type: 'loose', cardId: '4-clubs' }] });
    expect(next.sweepRecords[0].isFinalPlay).toBe(true);
  });
});

describe('turns (35-39)', () => {
  it('35. 4-player turn advances counter-clockwise (array order)', () => {
    const state = makeState({
      players: [
        makePlayer('p1', [card('4', 'spades')]),
        makePlayer('p2', [card('5', 'hearts')]),
        makePlayer('p3', [card('6', 'clubs')]),
        makePlayer('p4', [card('7', 'diamonds')])
      ]
    });
    const next = executeMove(state, 'p1', { kind: 'throw', handCardId: '4-spades' });
    expect(next.currentPlayerIndex).toBe(1);
  });

  it('36. the opening action hands the turn to the next player', () => {
    // p2 needs a card so this isn't ALSO end-of-play — the opening bidder having an empty hand
    // here is a pre-existing test simplification unrelated to what this test demonstrates.
    const state = makeState({
      players: [makePlayer('p1', []), makePlayer('p2', [card('K', 'clubs')])],
      floorLoose: [card('9', 'clubs')],
      phase: 'opening',
      currentPlayerIndex: 0,
      bidderId: 'p1'
    });
    const next = finalizeOpeningAndAdvance(state, 'p1', false);
    expect(next.currentPlayerIndex).toBe(1);
    expect(next.phase).toBe('playing');
  });

  it('38/39. an exhausted 2-player active hand transitions to reserve without changing turn order', () => {
    const state = makeState({
      players: [makePlayer('p1', [card('4', 'spades')]), makePlayer('p2', [], { reserve: [card('9', 'hearts'), card('10', 'clubs')] })],
      mode: '2player'
    });
    const next = executeMove(state, 'p1', { kind: 'throw', handCardId: '4-spades' });
    const p2After = next.players.find(p => p.id === 'p2')!;
    expect(p2After.hand).toHaveLength(2);
    expect(p2After.reserve).toHaveLength(0);
    expect(next.currentPlayerIndex).toBe(1);
  });
});

describe('safety: illegal actions never mutate state', () => {
  it('rejects a move submitted out of turn', () => {
    const state = makeState({ players: [makePlayer('p1', [card('4', 'spades')]), makePlayer('p2', [card('5', 'hearts')])] });
    expect(() => executeMove(state, 'p2', { kind: 'throw', handCardId: '5-hearts' })).toThrow(/not.*turn/);
  });

  it('rejects an unmatched capture target combination', () => {
    const j = card('J', 'hearts');
    const state = makeState({ players: [makePlayer('p1', [j]), makePlayer('p2', [])], floorLoose: [card('2', 'clubs')] });
    expect(() =>
      executeMove(state, 'p1', { kind: 'capture', handCardId: j.id, targets: [{ type: 'loose', cardId: '2-clubs' }] })
    ).toThrow(/not currently legal/);
  });
});

// ---------------------------------------------------------------------------
// Combine/Cement architecture — Build / Cement / Break / MergeFix / Add-to-Fixed as five
// distinct semantic actions, side-aware key responsibility, and the frozen Baazi joint-ownership
// rule. See the Ingredient 4/5 architecture proposal for the full reasoning.
// ---------------------------------------------------------------------------

describe('Combine/Cement architecture', () => {
  const team0: Team = { id: 'team-0', name: 'Team 0', playerIds: ['p1', 'p2'] };
  const team1: Team = { id: 'team-1', name: 'Team 1', playerIds: ['p3', 'p4'] };

  it('original creator cements their own house — same house id, owner unchanged, isCemented true', () => {
    const nineInHouse = card('9', 'hearts');
    const nineToPlay = card('9', 'spades');
    const spare = card('9', 'diamonds'); // retained per Ingredient 4's uniform retention rule
    const existing: House = { id: 'house-A', ownerSides: ['p1'], cards: [nineInHouse], captureValue: 9, isCemented: false };
    const state = makeState({ players: [makePlayer('p1', [nineToPlay, spare]), makePlayer('p2', [])], floorHouses: [existing], mode: '2player' });
    const next = executeMove(state, 'p1', { kind: 'cement', handCardId: nineToPlay.id, floorCardIds: [], existingHouseId: 'house-A', absorbedLooseCardIds: [] });
    const house = next.floor.houses.find(h => h.id === 'house-A')!;
    expect(house.id).toBe('house-A');
    expect(house.ownerSides).toEqual(['p1']); // union of (self) and (self) collapses to sole
    expect(house.isCemented).toBe(true);
    expect(house.cards.some(c => c.id === nineToPlay.id)).toBe(true);
    assertCardInvariant(next);
  });

  it('cementing a partner-owned house using ONLY the partner\'s key is legal (frozen: "responsible partner\'s key")', () => {
    const nine = card('9', 'clubs');
    const nineToPlay = card('9', 'spades'); // p1 plays this — holds no spare 9 themselves
    const partnerSpareKey = card('9', 'diamonds'); // p2 (p1's partner) holds the retained key instead
    const existing: House = { id: 'house-A', ownerSides: ['p2'], cards: [nine], captureValue: 9, isCemented: false };
    const state = makeState({
      players: [
        makePlayer('p1', [nineToPlay], { teamId: 'team-0' }),
        makePlayer('p2', [partnerSpareKey], { teamId: 'team-0' }),
        makePlayer('p3', [], { teamId: 'team-1' }),
        makePlayer('p4', [], { teamId: 'team-1' })
      ],
      floorHouses: [existing],
      teams: [team0, team1]
    });
    const next = executeMove(state, 'p1', { kind: 'cement', handCardId: nineToPlay.id, floorCardIds: [], existingHouseId: 'house-A', absorbedLooseCardIds: [] });
    const house = next.floor.houses.find(h => h.id === 'house-A')!;
    expect(house.isCemented).toBe(true);
    expect(house.ownerSides).toEqual(['team-0']); // same side before and after -> "remains", no join needed
  });

  it('cementing an opponent\'s (cross-side) house results in joint ownership by both sides', () => {
    const nine = card('9', 'clubs');
    const nineToPlay = card('9', 'spades');
    const spare = card('9', 'diamonds');
    const existing: House = { id: 'house-A', ownerSides: ['p1'], cards: [nine], captureValue: 9, isCemented: false }; // owned by team-0
    const state = makeState({
      players: [
        makePlayer('p1', [], { teamId: 'team-0' }),
        makePlayer('p2', [], { teamId: 'team-0' }),
        makePlayer('p3', [nineToPlay, spare], { teamId: 'team-1' }), // p3 (team-1) cements team-0's house
        makePlayer('p4', [], { teamId: 'team-1' })
      ],
      floorHouses: [existing],
      teams: [team0, team1],
      currentPlayerIndex: 2
    });
    const next = executeMove(state, 'p3', { kind: 'cement', handCardId: nineToPlay.id, floorCardIds: [], existingHouseId: 'house-A', absorbedLooseCardIds: [] });
    const house = next.floor.houses.find(h => h.id === 'house-A')!;
    expect(house.ownerSides.sort()).toEqual(['team-0', 'team-1']); // genuine joint ownership across sides
  });

  it('cementing is illegal when neither the acting side nor the pre-existing owner\'s side holds the key elsewhere relevant, and is simply not offered', () => {
    const nine = card('9', 'clubs');
    const nineToPlay = card('9', 'spades'); // p1 plays this, holds no spare, and p2 (partner) holds none either
    const existing: House = { id: 'house-A', ownerSides: ['p3'], cards: [nine], captureValue: 9, isCemented: false };
    const state = makeState({
      players: [
        makePlayer('p1', [nineToPlay], { teamId: 'team-0' }),
        makePlayer('p2', [], { teamId: 'team-0' }),
        makePlayer('p3', [], { teamId: 'team-1' }),
        makePlayer('p4', [], { teamId: 'team-1' })
      ],
      floorHouses: [existing],
      teams: [team0, team1]
    });
    expect(() => executeMove(state, 'p1', { kind: 'cement', handCardId: nineToPlay.id, floorCardIds: [], existingHouseId: 'house-A', absorbedLooseCardIds: [] })).toThrow(
      /not currently legal/
    );
  });

  it('Merge+Fix keeps sole ownership with the changer even though it produces a cemented house (distinct from Cement\'s joint rule)', () => {
    const two = card('2', 'spades');
    const jack = card('J', 'diamonds');
    const houseA: House = { id: 'house-A', ownerSides: ['p2'], cards: [card('9', 'clubs')], captureValue: 9, isCemented: false };
    const houseB: House = { id: 'house-B', ownerSides: ['p2'], cards: [card('J', 'clubs')], captureValue: 11, isCemented: false };
    const state = makeState({
      players: [makePlayer('p1', [two, jack]), makePlayer('p2', [])],
      floorHouses: [houseA, houseB],
      mode: '2player'
    });
    const next = executeMove(state, 'p1', { kind: 'mergeFix', handCardId: two.id, existingHouseId: 'house-A', absorbedLooseCardIds: [] });
    expect(next.floor.houses).toHaveLength(1); // merged into one
    const merged = next.floor.houses[0];
    expect(merged.captureValue).toBe(11);
    expect(merged.isCemented).toBe(true);
    expect(merged.ownerSides).toEqual(['p1']); // sole ownership to the changer, not joint
    expect(merged.cards.some(c => c.id === '9-clubs')).toBe(true);
    expect(merged.cards.some(c => c.id === 'J-clubs')).toBe(true);
    assertCardInvariant(next);
  });

  it('Add-to-Fixed never changes ownership, regardless of who performs it', () => {
    // Played card (7) plus a floor combo (3) reaches the house's value (10) — deliberately NOT
    // the played-card-alone case, since that now ties with Capture and is disallowed (explicit
    // Product Owner override, see the "add-to-fixed ties with capture" describe block below).
    const seven = card('7', 'hearts');
    const spare = card('10', 'diamonds');
    const cemented: House = {
      id: 'house-A',
      ownerSides: ['team-0', 'team-1'],
      cards: [card('9', 'clubs'), card('A', 'diamonds')],
      captureValue: 10,
      isCemented: true
    };
    const state = makeState({
      players: [makePlayer('p3', [seven, spare], { teamId: 'team-1' }), makePlayer('p1', [], { teamId: 'team-0' })],
      floorLoose: [card('3', 'spades')],
      floorHouses: [cemented],
      teams: [team0, team1]
    });
    const next = executeMove(state, 'p3', {
      kind: 'addToFixed',
      handCardId: seven.id,
      floorCardIds: ['3-spades'],
      existingHouseId: 'house-A',
      absorbedLooseCardIds: []
    });
    const house = next.floor.houses.find(h => h.id === 'house-A')!;
    expect(house.ownerSides.sort()).toEqual(['team-0', 'team-1']); // untouched
    expect(house.isCemented).toBe(true);
    expect(house.captureValue).toBe(10);
    expect(house.cards.some(c => c.id === seven.id)).toBe(true);
  });

  it('Add-to-Fixed uses a hand card plus compatible loose cards (Pagat: Ace+6+3=10), and separately absorbs any other compatible pair too', () => {
    const ace = card('A', 'hearts');
    const spare = card('A', 'diamonds');
    const cemented: House = { id: 'house-A', ownerSides: ['p1'], cards: [card('9', 'clubs'), card('J', 'diamonds')], captureValue: 10, isCemented: true };
    const state = makeState({
      players: [makePlayer('p1', [ace, spare]), makePlayer('p2', [])],
      // 6+3 is the primary combo alongside the Ace (Pagat's example); 8+2 is a coincidental
      // second combination that must ALSO be swept in automatically once Add-to-Fixed is chosen.
      floorLoose: [card('6', 'spades'), card('3', 'clubs'), card('8', 'diamonds'), card('2', 'hearts')],
      floorHouses: [cemented]
    });
    const next = executeMove(state, 'p1', { kind: 'addToFixed', handCardId: ace.id, floorCardIds: ['6-spades', '3-clubs'], existingHouseId: 'house-A', absorbedLooseCardIds: ['8-diamonds', '2-hearts'] });
    const house = next.floor.houses.find(h => h.id === 'house-A')!;
    expect(next.floor.loose).toHaveLength(0); // 6, 3, 8, and 2 all absorbed
    expect(house.cards.some(c => c.id === ace.id)).toBe(true);
    expect(house.cards.some(c => c.id === '6-spades')).toBe(true);
    expect(house.cards.some(c => c.id === '3-clubs')).toBe(true);
    expect(house.cards.some(c => c.id === '8-diamonds')).toBe(true);
    expect(house.cards.some(c => c.id === '2-hearts')).toBe(true);
    assertCardInvariant(next);
  });

  it('mandatory-capture does not apply to Combine: a house-aware, side-aware Cement and a Capture are both legal at once, and each choice executes its full consequences', () => {
    // p1 holds no spare 9 themselves — the Cement option only exists because their partner p2
    // holds the retained key (the side-aware "responsible partner's key" rule). The house is
    // owned by the opposing team (p3), so choosing Cement would also cross into joint ownership —
    // this exercises the full new house-aware path, not a generic/self-only build-or-capture test.
    const four = card('4', 'spades');
    const nine = card('9', 'hearts');
    const partnerSpareKey = card('9', 'diamonds');
    const existingNineHouse: House = { id: 'house-A', ownerSides: ['p3'], cards: [card('9', 'clubs')], captureValue: 9, isCemented: false };
    const state = makeState({
      players: [
        makePlayer('p1', [four, nine], { teamId: 'team-0' }),
        makePlayer('p2', [partnerSpareKey], { teamId: 'team-0' }),
        makePlayer('p3', [], { teamId: 'team-1' }),
        makePlayer('p4', [], { teamId: 'team-1' })
      ],
      floorLoose: [card('4', 'clubs')], // makes a plain Capture legal for the played 4
      floorHouses: [existingNineHouse],
      teams: [team0, team1]
    });

    // Both remain independently discoverable at the same decision point.
    expect(discoverLegalOptions(state, 'p1', four.id).some(o => o.kind === 'capture')).toBe(true);
    expect(discoverLegalOptions(state, 'p1', nine.id).some(o => o.kind === 'cement')).toBe(true);

    // Choosing Capture succeeds and leaves the house exactly as it was.
    const afterCapture = executeMove(state, 'p1', { kind: 'capture', handCardId: four.id, targets: [{ type: 'loose', cardId: '4-clubs' }] });
    expect(afterCapture.players.find(p => p.id === 'p1')!.captured.some(c => c.id === '4-clubs')).toBe(true);
    expect(afterCapture.floor.houses).toHaveLength(1);
    expect(afterCapture.floor.houses[0].isCemented).toBe(false);

    // Choosing Cement instead, from the same starting state, fully executes the cementing
    // consequences — including the cross-side joint ownership the house-aware path computed.
    const afterCement = executeMove(state, 'p1', { kind: 'cement', handCardId: nine.id, floorCardIds: [], existingHouseId: 'house-A', absorbedLooseCardIds: [] });
    const cemented = afterCement.floor.houses.find(h => h.id === 'house-A')!;
    expect(cemented.isCemented).toBe(true);
    expect(cemented.ownerSides.sort()).toEqual(['team-0', 'team-1']);
  });

  it('overlapping absorption combinations are separate player choices, not an unresolved error (Pagat: collect everything compatible, but choose between overlapping alternatives)', () => {
    // Floor loose 7♣ (the primary combo alongside the played 5), plus 9♣, 9♥, 3♦ — {9♣,3♦} and
    // {9♥,3♦} both sum to 12 but share the single 3♦, mirroring the classic pagat mandatory-
    // capture example (2+3+6 vs 5+6) already established for capture discovery.
    const five = card('5', 'spades');
    const seven = card('7', 'clubs');
    const spareTwelve = card('Q', 'hearts');
    const state = makeState({
      players: [makePlayer('p1', [five, spareTwelve]), makePlayer('p2', [])],
      floorLoose: [seven, card('9', 'clubs'), card('9', 'hearts'), card('3', 'diamonds')]
    });

    const options = discoverLegalOptions(state, 'p1', five.id).filter(
      (o): o is Extract<typeof o, { kind: 'build' }> => o.kind === 'build' && o.resultingValue === 12
    );
    expect(options).toHaveLength(2); // two separate, mutually exclusive choices — never merged, never guessed
    const absorbedSets = options.map(o => [...o.absorbedLooseCardIds].sort());
    expect(absorbedSets).toContainEqual(['3-diamonds', '9-clubs']);
    expect(absorbedSets).toContainEqual(['3-diamonds', '9-hearts']);

    // Choosing one succeeds and leaves the OTHER conflicting pair on the floor — never both.
    const chosen = options.find(o => o.absorbedLooseCardIds.includes('9-clubs'))!;
    const next = executeMove(state, 'p1', { kind: 'build', handCardId: five.id, floorCardIds: chosen.floorCardIds, absorbedLooseCardIds: chosen.absorbedLooseCardIds });
    const house = next.floor.houses[0];
    expect(house.cards.map(c => c.id).sort()).toEqual(['3-diamonds', '5-spades', '7-clubs', '9-clubs'].sort());
    expect(next.floor.loose.map(c => c.id)).toEqual(['9-hearts']); // the unchosen alternative remains untouched
    assertCardInvariant(next);
  });
});
