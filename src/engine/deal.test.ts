import { describe, expect, it } from 'vitest';
import { createDeck, shuffleDeck } from './deck';
import {
  assertCardInvariant,
  collectAllCards,
  dealMainHands2Player,
  dealMainHands4Player,
  dealOpeningHands,
  moveOpeningCard,
  revealFloor,
  submitBid
} from './deal';
import type { GameState, Player } from '../types';

function makePlayer(id: string, name: string): Player {
  return { id, name, teamId: null, hand: [], reserve: [], captured: [] };
}

function baseState(players: Player[], mode: GameState['mode']): GameState {
  return {
    gameId: 'test-game',
    mode,
    roundNumber: 1,
    players,
    teams: [],
    floor: { loose: [], houses: [] },
    deck: shuffleDeck(createDeck()),
    phase: 'dealing',
    currentPlayerIndex: 0,
    turnNumber: 0,
    bidValue: null,
    bidderId: null,
    sweepRecords: [],
    scores: {},
    roundScores: {},
    history: []
  };
}

const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'] as const;
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;

describe('deck', () => {
  it('has exactly 52 cards with unique ids', () => {
    const deck = createDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map(c => c.id)).size).toBe(52);
  });

  it('contains every rank/suit combination exactly once', () => {
    const deck = createDeck();
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        expect(deck.filter(c => c.suit === suit && c.rank === rank)).toHaveLength(1);
      }
    }
  });
});

describe('shuffleDeck', () => {
  it('preserves the same 52 physical cards', () => {
    const deck = createDeck();
    const shuffled = shuffleDeck(deck);
    expect(shuffled).toHaveLength(52);
    expect(new Set(shuffled.map(c => c.id)).size).toBe(52);
    expect(deck.every(c => shuffled.some(s => s.id === c.id))).toBe(true);
  });

  it('does not mutate the input array', () => {
    const deck = createDeck();
    const before = [...deck];
    shuffleDeck(deck);
    expect(deck).toEqual(before);
  });
});

const CALLER_ELIGIBLE_RANKS = new Set(['9', '10', 'J', 'Q', 'K']);

describe('caller eligibility guarantee (frozen "IMPORTANT NEW DEAL RULE")', () => {
  it('always deals the bidder at least one 9-13 card, even from an unshuffled deck', () => {
    // Pass in a deliberately UNshuffled deck to prove dealOpeningHands performs its own
    // randomizing shuffle rather than trusting whatever order it's given.
    for (let i = 0; i < 300; i++) {
      const players = [makePlayer('dealer', 'D'), makePlayer('bidder', 'B'), makePlayer('p3', '3'), makePlayer('p4', '4')];
      const state: GameState = { ...baseState(players, '4player'), deck: createDeck() };
      const dealt = dealOpeningHands(state, 'dealer');
      const bidderHand = dealt.players.find(p => p.id === dealt.bidderId)!.hand;
      expect(bidderHand.some(c => CALLER_ELIGIBLE_RANKS.has(c.rank))).toBe(true);
      assertCardInvariant(dealt);
    }
  });

  it('still produces varied, non-degenerate bidder hands across many deals', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const players = [makePlayer('dealer', 'D'), makePlayer('bidder', 'B'), makePlayer('p3', '3'), makePlayer('p4', '4')];
      const state = baseState(players, '4player');
      const dealt = dealOpeningHands(state, 'dealer');
      const bidderHand = dealt.players.find(p => p.id === dealt.bidderId)!.hand;
      seen.add(bidderHand.map(c => c.id).sort().join(','));
    }
    // With real randomness this should produce close to 200 distinct hands; a low number here
    // would indicate the eligibility retry is accidentally biasing or fixing the deal.
    expect(seen.size).toBeGreaterThan(150);
  });

  it('holds for 2-player mode as well', () => {
    for (let i = 0; i < 100; i++) {
      const players = [makePlayer('dealer', 'D'), makePlayer('bidder', 'B')];
      const state = baseState(players, '2player');
      const dealt = dealOpeningHands(state, 'dealer');
      const bidderHand = dealt.players.find(p => p.id === dealt.bidderId)!.hand;
      expect(bidderHand.some(c => CALLER_ELIGIBLE_RANKS.has(c.rank))).toBe(true);
      assertCardInvariant(dealt);
    }
  });

  it('in 2-player mode, the guarantee holds on the FIRST 4 cards specifically, not just somewhere in the full 12-card hand — those first 4 are the only cards the bidder actually looks at before calling', () => {
    for (let i = 0; i < 100; i++) {
      const players = [makePlayer('dealer', 'D'), makePlayer('bidder', 'B')];
      const state = baseState(players, '2player');
      const dealt = dealOpeningHands(state, 'dealer');
      const bidderHand = dealt.players.find(p => p.id === dealt.bidderId)!.hand;
      const firstFour = bidderHand.slice(0, 4);
      expect(firstFour.some(c => CALLER_ELIGIBLE_RANKS.has(c.rank))).toBe(true);
      assertCardInvariant(dealt);
    }
  });
});

describe('4-player deal flow', () => {
  function playFullFlow(dealerId = 'dealer', bidValue = 11) {
    const players = [makePlayer('dealer', 'Dealer'), makePlayer('bidder', 'Bidder'), makePlayer('p3', 'P3'), makePlayer('p4', 'P4')];
    let state = baseState(players, '4player');
    state = dealOpeningHands(state, dealerId);
    state = submitBid(state, state.bidderId!, bidValue);
    state = revealFloor(state);
    const openingCardId = state.players.find(p => p.id === state.bidderId)!.hand[0].id;
    state = moveOpeningCard(state, openingCardId);
    return { state, openingCardId };
  }

  it('deals bidder=4, floor=4, dealer=4, deck=40 initially', () => {
    const players = [makePlayer('dealer', 'Dealer'), makePlayer('bidder', 'Bidder'), makePlayer('p3', 'P3'), makePlayer('p4', 'P4')];
    let state = baseState(players, '4player');
    state = dealOpeningHands(state, 'dealer');
    expect(state.bidderId).toBe('bidder'); // next in seating order after dealer
    expect(state.players.find(p => p.id === 'bidder')!.hand).toHaveLength(4);
    expect(state.players.find(p => p.id === 'dealer')!.hand).toHaveLength(4);
    expect(state.floor.loose).toHaveLength(4);
    expect(state.deck).toHaveLength(40);
    expect(state.phase).toBe('bidding');
    assertCardInvariant(state);
  });

  it('moves the opening card physically without fabricating a house or capture', () => {
    const { state, openingCardId } = playFullFlow();
    expect(state.players.find(p => p.id === state.bidderId)!.hand).toHaveLength(3);
    expect(state.floor.loose.some(c => c.id === openingCardId)).toBe(true);
    expect(state.floor.houses).toHaveLength(0);
    expect(state.players.every(p => p.captured.length === 0)).toBe(true);
    expect(state.phase).toBe('opening');
    assertCardInvariant(state);
  });

  it('produces the correct final counts: 11 / 12 / 12 / 12, deck=0', () => {
    const { state } = playFullFlow();
    const final = dealMainHands4Player(state, 'dealer');
    expect(final.players.find(p => p.id === 'bidder')!.hand).toHaveLength(11);
    expect(final.players.find(p => p.id === 'dealer')!.hand).toHaveLength(12);
    expect(final.players.find(p => p.id === 'p3')!.hand).toHaveLength(12);
    expect(final.players.find(p => p.id === 'p4')!.hand).toHaveLength(12);
    expect(final.deck).toHaveLength(0);
    // Phase stays 'opening' here — dealing the main hands doesn't itself start play;
    // Ingredient 5/6's finalizeOpeningAndAdvance is the sole place that transitions to 'playing'
    // (it also needs every hand already dealt to correctly find the next player to act).
    expect(final.phase).toBe('opening');
    assertCardInvariant(final);
    expect(collectAllCards(final)).toHaveLength(52);
  });

  it('populates state.teams (opposite-seat pairing) when missing, so 4-player side-aware rules have valid state to evaluate — NOT an approved team-assignment rule, see the flagged comment on assignDefaultTeamsIfMissing', () => {
    const { state } = playFullFlow();
    expect(state.teams).toHaveLength(0); // unset up to this point in the flow
    const final = dealMainHands4Player(state, 'dealer');
    expect(final.teams).toHaveLength(2);
    const dealerTeam = final.teams.find(t => t.playerIds.includes('dealer'))!;
    const bidderTeam = final.teams.find(t => t.playerIds.includes('bidder'))!;
    expect(dealerTeam).toBeDefined();
    expect(bidderTeam).toBeDefined();
    expect(dealerTeam.id).not.toBe(bidderTeam.id); // seating order is dealer, bidder, p3, p4 -> opposite seats
    expect(dealerTeam.playerIds).toContain('p3');
    expect(bidderTeam.playerIds).toContain('p4');
  });

  it('preserves already-assigned teams across a re-deal rather than reassigning them', () => {
    const { state } = playFullFlow();
    const preAssigned = { ...state, teams: [{ id: 'fixed-team-0', name: 'Fixed', playerIds: ['dealer', 'p4'] as [string, string] }, { id: 'fixed-team-1', name: 'Fixed', playerIds: ['bidder', 'p3'] as [string, string] }] };
    const final = dealMainHands4Player(preAssigned, 'dealer');
    expect(final.teams).toEqual(preAssigned.teams);
  });
});

describe('2-player deal flow (authoritative sequence: 4 floor -> 12/12 deal -> opening move -> 11/12 active hands -> 12/12 reserve)', () => {
  it('initial deal: floor=4, P1 (bidder) hand=12, P2 (dealer) hand=12, deck=24', () => {
    const players = [makePlayer('dealer', 'Dealer'), makePlayer('bidder', 'Bidder')];
    let state = baseState(players, '2player');
    state = dealOpeningHands(state, 'dealer');
    expect(state.bidderId).toBe('bidder'); // next in seating order after dealer
    expect(state.players.find(p => p.id === 'bidder')!.hand).toHaveLength(12);
    expect(state.players.find(p => p.id === 'dealer')!.hand).toHaveLength(12);
    expect(state.floor.loose).toHaveLength(4);
    expect(state.deck).toHaveLength(24); // 52 - 12 - 4 - 12, exactly enough left for both 12-card reserves
    expect(state.phase).toBe('bidding');
    assertCardInvariant(state);
    expect(collectAllCards(state)).toHaveLength(52);
  });

  it("after P1's opening move: P1 hand=11, P2 hand=12, and the opening card is physically on the floor", () => {
    const players = [makePlayer('dealer', 'Dealer'), makePlayer('bidder', 'Bidder')];
    let state = baseState(players, '2player');
    state = dealOpeningHands(state, 'dealer');
    state = submitBid(state, state.bidderId!, 9);
    state = revealFloor(state);

    // The opening move is played from the bidder's already-complete 12-card hand, not from some
    // still-partial 4-card hand dealt before the rest arrives.
    const bidderBeforeOpening = state.players.find(p => p.id === state.bidderId)!;
    expect(bidderBeforeOpening.hand).toHaveLength(12);
    const openingCardId = bidderBeforeOpening.hand[0].id;

    state = moveOpeningCard(state, openingCardId);
    const bidder = state.players.find(p => p.id === state.bidderId)!;
    const dealer = state.players.find(p => p.id !== state.bidderId)!;
    expect(bidder.hand).toHaveLength(11);
    expect(dealer.hand).toHaveLength(12);
    // The opening card is not removed from the game — it moved from the bidder's hand to the
    // floor as a loose card (Ingredient 2's moveOpeningCard performs physical movement only; a
    // later opening action — build/capture — may move it again, but that's Ingredient 3's job).
    expect(state.floor.loose.some(c => c.id === openingCardId)).toBe(true);
    expect(state.floor.houses).toHaveLength(0);
    expect(state.phase).toBe('opening');
    assertCardInvariant(state);
    expect(collectAllCards(state)).toHaveLength(52);
  });

  it('reserve: both players receive a 12-card reserve, deck=0, active hands (11/12) untouched', () => {
    const players = [makePlayer('dealer', 'Dealer'), makePlayer('bidder', 'Bidder')];
    let state = baseState(players, '2player');
    state = dealOpeningHands(state, 'dealer');
    state = submitBid(state, state.bidderId!, 9);
    state = revealFloor(state);
    const openingCardId = state.players.find(p => p.id === state.bidderId)!.hand[0].id;
    state = moveOpeningCard(state, openingCardId);
    assertCardInvariant(state);

    const final = dealMainHands2Player(state, 'dealer');
    const bidder = final.players.find(p => p.id === 'bidder')!;
    const dealer = final.players.find(p => p.id === 'dealer')!;
    // dealMainHands2Player no longer deals any "main hand" packets for 2-player — those are
    // already fully dealt by dealOpeningHands — so the active hands from the opening move are
    // untouched here; only reserves are dealt.
    expect(bidder.hand).toHaveLength(11);
    expect(dealer.hand).toHaveLength(12);
    expect(bidder.reserve).toHaveLength(12);
    expect(dealer.reserve).toHaveLength(12);
    expect(final.deck).toHaveLength(0);
    // Phase stays 'opening' here — dealing the reserves doesn't itself start play;
    // Ingredient 5/6's finalizeOpeningAndAdvance is the sole place that transitions to 'playing'
    // (it also needs every hand already dealt to correctly find the next player to act).
    expect(final.phase).toBe('opening');
    assertCardInvariant(final);
    expect(collectAllCards(final)).toHaveLength(52);
  });
});

describe('guard rails', () => {
  it('rejects a bid before dealing has happened', () => {
    const players = [makePlayer('dealer', 'Dealer'), makePlayer('bidder', 'Bidder'), makePlayer('p3', 'P3'), makePlayer('p4', 'P4')];
    const state = baseState(players, '4player');
    expect(() => submitBid(state, 'bidder', 9)).toThrow();
  });

  it('rejects a bid from someone other than the bidder', () => {
    const players = [makePlayer('dealer', 'Dealer'), makePlayer('bidder', 'Bidder'), makePlayer('p3', 'P3'), makePlayer('p4', 'P4')];
    let state = baseState(players, '4player');
    state = dealOpeningHands(state, 'dealer');
    expect(() => submitBid(state, 'p3', 9)).toThrow();
  });

  it('rejects an out-of-range bid value', () => {
    const players = [makePlayer('dealer', 'Dealer'), makePlayer('bidder', 'Bidder'), makePlayer('p3', 'P3'), makePlayer('p4', 'P4')];
    let state = baseState(players, '4player');
    state = dealOpeningHands(state, 'dealer');
    expect(() => submitBid(state, 'bidder', 7)).toThrow();
  });

  it('rejects revealing the floor before a bid exists', () => {
    const players = [makePlayer('dealer', 'Dealer'), makePlayer('bidder', 'Bidder'), makePlayer('p3', 'P3'), makePlayer('p4', 'P4')];
    let state = baseState(players, '4player');
    state = dealOpeningHands(state, 'dealer');
    expect(() => revealFloor(state)).toThrow();
  });
});

describe('randomized card-accounting fuzz', () => {
  it('holds the 52-unique-card invariant across many shuffles', () => {
    for (let i = 0; i < 100; i++) {
      const players = [makePlayer('dealer', 'D'), makePlayer('bidder', 'B'), makePlayer('p3', '3'), makePlayer('p4', '4')];
      let state = baseState(players, '4player');
      state = dealOpeningHands(state, 'dealer');
      state = submitBid(state, state.bidderId!, 10);
      state = revealFloor(state);
      state = moveOpeningCard(state, state.players.find(p => p.id === state.bidderId)!.hand[0].id);
      state = dealMainHands4Player(state, 'dealer');
      assertCardInvariant(state);
      expect(state.players.find(p => p.id === 'bidder')!.hand).toHaveLength(11);
      expect(state.deck).toHaveLength(0);
    }
  });
});

describe('assertCardInvariant — stronger checks (Section 4 of the follow-up authorization)', () => {
  function finalFourPlayerState() {
    const players = [makePlayer('dealer', 'D'), makePlayer('bidder', 'B'), makePlayer('p3', '3'), makePlayer('p4', '4')];
    let state = baseState(players, '4player');
    state = dealOpeningHands(state, 'dealer');
    state = submitBid(state, state.bidderId!, 10);
    state = revealFloor(state);
    state = moveOpeningCard(state, state.players.find(p => p.id === state.bidderId)!.hand[0].id);
    return dealMainHands4Player(state, 'dealer');
  }

  it('passes on a clean, correctly-dealt state', () => {
    expect(() => assertCardInvariant(finalFourPlayerState())).not.toThrow();
  });

  it('catches a missing card (total count off)', () => {
    const state = finalFourPlayerState();
    const corrupted: GameState = {
      ...state,
      players: state.players.map((p, i) => (i === 0 ? { ...p, hand: p.hand.slice(1) } : p))
    };
    expect(() => assertCardInvariant(corrupted)).toThrow(/52/);
  });

  it('catches the same card id existing in two physical locations at once, naming both', () => {
    const state = finalFourPlayerState();
    const p0 = state.players[0];
    const dupCard = p0.hand[0];
    const trimmedHand = p0.hand.slice(0, -1); // drop a different card so total count stays 52
    const corrupted: GameState = {
      ...state,
      players: state.players.map((p, i) => {
        if (i === 0) return { ...p, hand: trimmedHand };
        if (i === 1) return { ...p, hand: [...p.hand, dupCard] };
        return p;
      })
    };
    expect(() => assertCardInvariant(corrupted)).toThrow(/more than one physical location/);
    try {
      assertCardInvariant(corrupted);
    } catch (e) {
      expect((e as Error).message).toContain(dupCard.id);
    }
  });

  it('catches a fabricated card id that is not part of the canonical 52-card deck', () => {
    const state = finalFourPlayerState();
    const fakeCard = { id: 'FAKE-CARD-999', rank: 'A', suit: 'spades' } as const;
    const corrupted: GameState = {
      ...state,
      players: state.players.map((p, i) => (i === 0 ? { ...p, hand: [fakeCard, ...p.hand.slice(1)] } : p))
    };
    // A 1-for-1 substitution simultaneously makes one real id "missing" and introduces one
    // "foreign" id — the invariant checks both directions, so either framing is a correct catch.
    expect(() => assertCardInvariant(corrupted)).toThrow(/canonical/);
  });
});
