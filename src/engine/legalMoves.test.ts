import { describe, expect, it } from 'vitest';
import { discoverLegalOptions, discoverLegalOptionsForHand } from './legalMoves';
import { createDeck } from './deck';
import type { Card, GameState, House, Player } from '../types';

function card(rank: Card['rank'], suit: Card['suit']): Card {
  return { id: `${rank}-${suit}`, rank, suit };
}

function makePlayer(id: string, hand: Card[]): Player {
  return { id, name: id, teamId: null, hand, reserve: [], captured: [] };
}

function makeOpeningState(opts: { bidderHand: Card[]; floorLoose?: Card[]; floorHouses?: House[]; bidValue?: number }): GameState {
  const floorLoose = opts.floorLoose ?? [];
  const floorHouses = opts.floorHouses ?? [];
  const used = new Set([...opts.bidderHand, ...floorLoose, ...floorHouses.flatMap(h => h.cards)].map(c => c.id));
  const rest = createDeck().filter(c => !used.has(c.id));
  return {
    gameId: 'g',
    mode: '4player',
    roundNumber: 1,
    players: [makePlayer('bidder', opts.bidderHand), makePlayer('dealer', []), makePlayer('elsewhere', rest)],
    teams: [],
    floor: { loose: floorLoose, houses: floorHouses },
    deck: [],
    phase: 'revealing',
    currentPlayerIndex: 0,
    turnNumber: 0,
    bidValue: opts.bidValue ?? 11,
    bidderId: 'bidder',
    sweepRecords: [],
    scores: {},
    roundScores: {},
    history: []
  };
}

function makeNormalState(opts: { hand: Card[]; floorLoose?: Card[]; floorHouses?: House[] }): GameState {
  const floorLoose = opts.floorLoose ?? [];
  const floorHouses = opts.floorHouses ?? [];
  const used = new Set([...opts.hand, ...floorLoose, ...floorHouses.flatMap(h => h.cards)].map(c => c.id));
  const rest = createDeck().filter(c => !used.has(c.id));
  return {
    gameId: 'g',
    // None of this file's tests exercise partnership behavior; 2-player mode means sideOf()
    // never needs state.teams at all, which is the honest characterization of these fixtures
    // (a handful of individual players, not a real 4-player game with partnerships).
    mode: '2player',
    roundNumber: 1,
    players: [makePlayer('p1', opts.hand), makePlayer('p2', []), makePlayer('elsewhere', rest)],
    teams: [],
    floor: { loose: floorLoose, houses: floorHouses },
    deck: [],
    phase: 'playing',
    currentPlayerIndex: 0,
    turnNumber: 5,
    bidValue: null,
    bidderId: null,
    sweepRecords: [],
    scores: {},
    roundScores: {},
    history: []
  };
}

describe('legal move discovery — required cases', () => {
  it('1. a card with no legal action (opening, irrelevant card)', () => {
    const j = card('J', 'hearts');
    const four = card('4', 'spades');
    const state = makeOpeningState({ bidderHand: [j, four], bidValue: 11 });
    expect(discoverLegalOptions(state, 'bidder', four.id)).toHaveLength(0);
  });

  it('2. a card with exactly one legal action (opening fallback throw)', () => {
    const j = card('J', 'hearts');
    const state = makeOpeningState({ bidderHand: [j], bidValue: 11 });
    const opts = discoverLegalOptions(state, 'bidder', j.id);
    expect(opts).toHaveLength(1);
    expect(opts[0].kind).toBe('throw');
  });

  it('3 & 4. a card with multiple legal actions, including multiple Combine options (SeepKing observation)', () => {
    const sixHeart = card('6', 'hearts');
    const hand = [
      sixHeart,
      card('7', 'spades'),
      card('2', 'hearts'),
      card('A', 'clubs'),
      card('6', 'clubs'),
      card('8', 'clubs'),
      card('10', 'spades'),
      card('J', 'diamonds')
    ];
    const floorLoose = [card('J', 'hearts'), card('4', 'diamonds'), card('5', 'diamonds')];
    const state = makeNormalState({ hand, floorLoose });
    const opts = discoverLegalOptions(state, 'p1', sixHeart.id);
    expect(opts.length).toBeGreaterThan(1);

    const builds = opts.filter((o): o is Extract<typeof o, { kind: 'build' }> => o.kind === 'build');
    expect(builds.some(b => b.resultingValue === 11 && b.floorCardIds.includes('5-diamonds'))).toBe(true);
    expect(builds.some(b => b.resultingValue === 10 && b.floorCardIds.includes('4-diamonds'))).toBe(true);
  });

  it('5. Combine and Collect coexist for the same selected card (neither discarded)', () => {
    const six = card('6', 'hearts');
    const hand = [six, card('J', 'clubs')];
    const floorLoose = [card('5', 'diamonds'), card('6', 'spades')];
    const state = makeNormalState({ hand, floorLoose });
    const opts = discoverLegalOptions(state, 'p1', six.id);
    expect(opts.some(o => o.kind === 'build')).toBe(true);
    expect(opts.some(o => o.kind === 'capture')).toBe(true);
  });

  it('6a. overlapping capture combinations remain separate, mutually exclusive choices', () => {
    // Classic pagat example: floor 2,3,5,6 with an 11 played. {2,3,6}=11 and {5,6}=11 share the
    // physical 6 — you cannot take both, so these must stay two distinct alternatives.
    const j = card('J', 'hearts');
    const floorLoose = [card('2', 'clubs'), card('3', 'diamonds'), card('5', 'spades'), card('6', 'hearts')];
    const state = makeNormalState({ hand: [j], floorLoose });
    const opts = discoverLegalOptions(state, 'p1', j.id).filter(o => o.kind === 'capture');
    expect(opts).toHaveLength(2);
    const sizes = opts.map(o => (o.kind === 'capture' ? o.targets.length : 0)).sort();
    expect(sizes).toEqual([2, 3]);
  });

  it('6b. non-overlapping capture combinations must be combined into one complete capture', () => {
    // Floor 7,4,2,9 with an 11 played: {7,4}=11 and {2,9}=11 share nothing, so a single play
    // must gather both groups together in one action — never offered as two separate choices.
    const j = card('J', 'hearts');
    const floorLoose = [card('7', 'clubs'), card('4', 'diamonds'), card('2', 'spades'), card('9', 'hearts')];
    const state = makeNormalState({ hand: [j], floorLoose });
    const opts = discoverLegalOptions(state, 'p1', j.id).filter(o => o.kind === 'capture');
    expect(opts).toHaveLength(1);
    expect(opts[0].kind === 'capture' && opts[0].targets).toHaveLength(4);
  });

  it('6c. an independently capturable House combines with a non-overlapping loose capture into one action', () => {
    const j = card('J', 'hearts');
    const houseCards = [card('6', 'clubs'), card('3', 'clubs')];
    const house: House = { id: 'house-1', ownerSides: ['p2'], cards: houseCards, captureValue: 11, isCemented: false };
    const state = makeNormalState({ hand: [j], floorLoose: [card('7', 'diamonds'), card('4', 'spades')], floorHouses: [house] });
    const opts = discoverLegalOptions(state, 'p1', j.id).filter(o => o.kind === 'capture');
    expect(opts).toHaveLength(1);
    const targets = opts[0].kind === 'capture' ? opts[0].targets : [];
    expect(targets.some(t => t.type === 'house' && t.houseId === 'house-1')).toBe(true);
    expect(targets.some(t => t.type === 'loose' && t.cardId === '7-diamonds')).toBe(true);
    expect(targets.some(t => t.type === 'loose' && t.cardId === '4-spades')).toBe(true);
    // Never a partial option that grabs the house but leaves an independently-reachable loose card behind.
    expect(opts.every(o => o.kind !== 'capture' || o.targets.length === 3)).toBe(true);
  });

  it('6d. overlapping absorption combinations for a house-landing action remain separate, mutually exclusive choices (mirrors 6a for Build/Cement/Break/MergeFix/Add-to-Fixed)', () => {
    // Same pagat floor (2,3,5,6) and same overlap on the 6, but exercised through Build's
    // "collect all compatible combinations" absorption rather than capture — per the corrected
    // understanding that overlapping combinations are a player choice, not an unresolved case.
    const j = card('J', 'hearts');
    const jSpare = card('J', 'clubs'); // retained key, making the build legal
    const floorLoose = [card('2', 'clubs'), card('3', 'diamonds'), card('5', 'spades'), card('6', 'hearts')];
    const state = makeNormalState({ hand: [j, jSpare], floorLoose });
    const opts = discoverLegalOptions(state, 'p1', j.id).filter(
      (o): o is Extract<typeof o, { kind: 'build' }> => o.kind === 'build' && o.resultingValue === 11
    );
    expect(opts).toHaveLength(2); // {2,3,6} and {5,6} — never merged, never guessed
    const sizes = opts.map(o => o.absorbedLooseCardIds.length).sort();
    expect(sizes).toEqual([2, 3]);
  });

  it('7. house capture by matching value', () => {
    const j = card('J', 'hearts');
    const houseCards = [card('6', 'clubs'), card('5', 'clubs')];
    const house: House = { id: 'house-1', ownerSides: ['p2'], cards: houseCards, captureValue: 11, isCemented: false };
    const state = makeNormalState({ hand: [j], floorHouses: [house] });
    const opts = discoverLegalOptions(state, 'p1', j.id);
    expect(opts.some(o => o.kind === 'capture' && o.targets.length === 1 && o.targets[0].type === 'house')).toBe(true);
  });

  it('8. a lone King remains a loose card and is never treated as a House', () => {
    const j = card('J', 'hearts');
    const kingInHand = card('K', 'spades');
    const floorKing = card('K', 'hearts');
    const state = makeNormalState({ hand: [j, kingInHand], floorLoose: [floorKing] });
    const opts = discoverLegalOptions(state, 'p1', kingInHand.id);
    const captureOfFloorKing = opts.find(o => o.kind === 'capture' && o.targets[0].type === 'loose' && (o.targets[0] as any).cardId === floorKing.id);
    expect(captureOfFloorKing).toBeDefined();
  });

  it('9. invalid build values below 9 are never exposed', () => {
    const two = card('2', 'clubs');
    const state = makeNormalState({ hand: [two, card('J', 'hearts')] });
    const opts = discoverLegalOptions(state, 'p1', two.id);
    expect(opts.filter(o => o.kind === 'build' && o.resultingValue < 9)).toHaveLength(0);
  });

  it('10. physical card identity is preserved in the discovered option', () => {
    const six = card('6', 'hearts');
    const five = card('5', 'diamonds');
    const state = makeNormalState({ hand: [six, card('J', 'clubs')], floorLoose: [five] });
    const opts = discoverLegalOptions(state, 'p1', six.id);
    const build = opts.find(o => o.kind === 'build' && o.resultingValue === 11);
    expect(build).toBeDefined();
    expect((build as any).floorCardIds).toContain(five.id);
  });

  it('11. Build Priority is respected: when a legal build exists, nothing else is offered anywhere in the hand', () => {
    const two = card('2', 'clubs');
    const j = card('J', 'hearts');
    const state = makeOpeningState({ bidderHand: [two, j], floorLoose: [card('6', 'spades'), card('3', 'diamonds')], bidValue: 11 });
    const all = discoverLegalOptionsForHand(state, 'bidder');
    const everything = Object.values(all).flat();
    expect(everything.every(o => o.kind === 'build')).toBe(true);
    expect(all[two.id].some(o => o.kind === 'build')).toBe(true);
  });

  it('12. no strategic ranking or recommendation fields are produced', () => {
    const six = card('6', 'hearts');
    const state = makeNormalState({
      hand: [six, card('J', 'clubs'), card('10', 'diamonds')],
      floorLoose: [card('5', 'diamonds'), card('4', 'clubs')]
    });
    const opts = discoverLegalOptions(state, 'p1', six.id);
    expect(opts.some(o => 'score' in o || 'recommended' in o || 'best' in o)).toBe(false);
  });

  it('bonus: a hand card duplicated in rank can build alone while retaining its twin', () => {
    const jHearts = card('J', 'hearts');
    const jClubs = card('J', 'clubs');
    const state = makeOpeningState({ bidderHand: [jHearts, jClubs], bidValue: 11 });
    const all = discoverLegalOptionsForHand(state, 'bidder');
    expect(all[jHearts.id].some(o => o.kind === 'build' && o.floorCardIds.length === 0)).toBe(true);
    expect(all[jClubs.id].some(o => o.kind === 'build' && o.floorCardIds.length === 0)).toBe(true);
  });

  it('mandatory capture: throw is illegal for a card that has an available capture', () => {
    const four = card('4', 'spades');
    const state = makeNormalState({ hand: [four], floorLoose: [card('4', 'clubs')] });
    const opts = discoverLegalOptions(state, 'p1', four.id);
    expect(opts.some(o => o.kind === 'capture')).toBe(true);
    expect(opts.some(o => o.kind === 'throw')).toBe(false);
  });

  it('mandatory capture: throw remains legal for a card with no available capture', () => {
    const four = card('4', 'spades');
    const state = makeNormalState({ hand: [four], floorLoose: [] });
    const opts = discoverLegalOptions(state, 'p1', four.id);
    expect(opts).toHaveLength(1);
    expect(opts[0].kind).toBe('throw');
  });

  it('performance: stays fast on a realistically-sized cluttered floor', () => {
    // A large but plausible floor (12 loose cards, varied ranks) — not the pathological
    // all-small-value case that now deliberately trips the safety guard (see below).
    const floorLoose = [
      card('2', 'hearts'), card('3', 'diamonds'), card('5', 'clubs'), card('6', 'spades'), card('7', 'hearts'),
      card('8', 'diamonds'), card('9', 'clubs'), card('4', 'spades'), card('A', 'hearts'), card('10', 'diamonds'),
      card('2', 'clubs'), card('3', 'spades')
    ];
    const hand = [card('K', 'hearts')];
    const state = makeNormalState({ hand, floorLoose });

    const start = Date.now();
    discoverLegalOptionsForHand(state, 'p1');
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('safety guard: a pathologically cluttered floor fails fast and diagnosably instead of hanging', () => {
    // Finding all maximal non-overlapping capture combinations is set-packing (NP-hard in
    // general). This floor is deliberately adversarial — many small cards across all four
    // suits — and is known to produce thousands of atomic groups. The guard should reject it
    // quickly with a clear message rather than hang.
    const suits: Card['suit'][] = ['hearts', 'diamonds', 'clubs', 'spades'];
    const ranks: Card['rank'][] = ['A', '2', '3', '4', '5'];
    const floorLoose: Card[] = [];
    for (const s of suits) for (const r of ranks) floorLoose.push(card(r, s));
    const hand = [card('K', 'hearts')];
    const state = makeNormalState({ hand, floorLoose });

    const start = Date.now();
    expect(() => discoverLegalOptionsForHand(state, 'p1')).toThrow(/intractable/);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('Add-to-Fixed requires retaining a card to eventually capture the house (explicit Product Owner rule, normal play)', () => {
  // Baazi-specific (Pagat's own policy explicitly allows agreed local/house-rule variations —
  // pagat.com/policy.html; not claiming Pagat or any other source states this exact rule). This is
  // a RETAINS check — the same concept already governing Build and Cement — NOT "Capture wins a
  // strategic tie" and NOT about who owns the house. When a hand card ALONE matches a fixed
  // house's value, using it for Add-to-Fixed is illegal unless the hand still holds ANOTHER card
  // of that value afterward — you cannot make/add to a pukka house you'd have no remaining
  // matching card left to ever collect.

  it('Test 1 — a single matching card: Capture is legal, Add-to-Fixed is NOT (no card would remain to ever collect the house)', () => {
    const jack = card('J', 'diamonds'); // rank value 11 — the only Jack in hand
    const fixedHouse: House = {
      id: 'house-A',
      ownerSides: ['p1'],
      cards: [card('9', 'clubs'), card('2', 'hearts')],
      captureValue: 11,
      isCemented: true
    };
    const state = makeNormalState({ hand: [jack, card('5', 'hearts')], floorHouses: [fixedHouse] });

    const options = discoverLegalOptions(state, 'p1', jack.id);
    expect(options.some(o => o.kind === 'capture')).toBe(true);
    expect(options.some(o => o.kind === 'addToFixed')).toBe(false);
  });

  it('Test 2 — multiple matching cards: Add-to-Fixed may remain legal, since another matching card stays in hand to capture later', () => {
    const jack1 = card('J', 'diamonds');
    const jack2 = card('J', 'clubs'); // the spare that keeps eventual capture possible
    const fixedHouse: House = {
      id: 'house-A',
      ownerSides: ['p1'],
      cards: [card('9', 'clubs'), card('2', 'hearts')],
      captureValue: 11,
      isCemented: true
    };
    const state = makeNormalState({ hand: [jack1, jack2, card('5', 'hearts')], floorHouses: [fixedHouse] });

    const options = discoverLegalOptions(state, 'p1', jack1.id);
    expect(options.some(o => o.kind === 'addToFixed')).toBe(true);
    expect(options.some(o => o.kind === 'capture')).toBe(true); // still a free choice either way
  });

  it('Test 2b — same direct match, even with unrelated floor combinations lying around: retains is about the HAND, not the floor', () => {
    const jack = card('J', 'clubs'); // only Jack in hand
    const fixedHouse: House = {
      id: 'house-A',
      ownerSides: ['p1'],
      cards: [card('9', 'clubs'), card('2', 'hearts')],
      captureValue: 11,
      isCemented: true
    };
    const state = makeNormalState({
      hand: [jack, card('3', 'hearts')],
      floorLoose: [card('5', 'spades'), card('6', 'diamonds')], // an unrelated 5+6=11 combo, not involving the J
      floorHouses: [fixedHouse]
    });

    const options = discoverLegalOptions(state, 'p1', jack.id);
    expect(options.some(o => o.kind === 'capture')).toBe(true);
    expect(options.some(o => o.kind === 'addToFixed')).toBe(false);
  });

  it('Test 3 — a non-matching card reaching the value only via a floor combination: Add-to-Fixed remains legal regardless of retains', () => {
    // Hand card is a 5 (rank value 5), combined with a loose floor 6, lands on the house's value
    // of 11. The 5 itself is not an 11, so there is no capture ability at stake for this card —
    // normal-play Capture always targets the played card's own rank (5), not 11.
    const five = card('5', 'hearts');
    const fixedHouse: House = {
      id: 'house-A',
      ownerSides: ['p1'],
      cards: [card('9', 'clubs'), card('A', 'hearts')],
      captureValue: 11,
      isCemented: true
    };
    const state = makeNormalState({ hand: [five, card('3', 'clubs')], floorLoose: [card('6', 'spades')], floorHouses: [fixedHouse] });

    const options = discoverLegalOptions(state, 'p1', five.id);
    expect(options.some(o => o.kind === 'addToFixed')).toBe(true);
  });

  it('applies regardless of who owns the fixed house — this is about the acting player\'s own hand, not house ownership', () => {
    const jack = card('J', 'diamonds'); // only Jack in hand
    const opponentsFixedHouse: House = {
      id: 'house-A',
      ownerSides: ['p2'],
      cards: [card('9', 'clubs'), card('2', 'hearts')],
      captureValue: 11,
      isCemented: true
    };
    const state = makeNormalState({ hand: [jack, card('5', 'hearts')], floorHouses: [opponentsFixedHouse] });

    const options = discoverLegalOptions(state, 'p1', jack.id);
    expect(options.some(o => o.kind === 'addToFixed')).toBe(false);
    expect(options.some(o => o.kind === 'capture')).toBe(true);
  });
});
