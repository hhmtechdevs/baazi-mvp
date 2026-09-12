import type { Card, GameState, Player, Rank, Team } from '../types';
import { createDeck, shuffleDeck } from './deck';

// ---------------------------------------------------------------------------
// Small internal helpers. No exported rule logic lives here — just the
// bookkeeping needed to move physical cards between locations safely.
// ---------------------------------------------------------------------------

function requirePhase(state: GameState, phase: GameState['phase']): void {
  if (state.phase !== phase) {
    throw new Error(`Expected phase "${phase}" but game is in phase "${state.phase}".`);
  }
}

function getPlayer(state: GameState, playerId: string): Player {
  const player = state.players.find(p => p.id === playerId);
  if (!player) throw new Error(`Unknown player: ${playerId}`);
  return player;
}

/** The next player in seating order after `fromPlayerId` (i.e. "to their right"). */
function nextPlayerId(state: GameState, fromPlayerId: string): string {
  const index = state.players.findIndex(p => p.id === fromPlayerId);
  if (index === -1) throw new Error(`Unknown player: ${fromPlayerId}`);
  return state.players[(index + 1) % state.players.length].id;
}

function updatePlayer(state: GameState, playerId: string, changes: Partial<Player>): GameState {
  return {
    ...state,
    players: state.players.map(p => (p.id === playerId ? { ...p, ...changes } : p))
  };
}

function takeFromDeck(state: GameState, count: number): { cards: Card[]; state: GameState } {
  if (state.deck.length < count) {
    throw new Error(`Not enough cards in deck: need ${count}, have ${state.deck.length}.`);
  }
  return { cards: state.deck.slice(0, count), state: { ...state, deck: state.deck.slice(count) } };
}

// ---------------------------------------------------------------------------
// A. Initial deal (Section 6.C), with the caller-eligibility guarantee (frozen "IMPORTANT NEW
// DEAL RULE").
//
// 4-player: bidder 4, floor 4, dealer 4 — unchanged. The remaining 8 players' cards (and the rest
// of the bidder/dealer's hands) are dealt afterward by dealMainHands4Player, once the opening
// card has been played.
//
// 2-player: bidder 12, floor 4, dealer 12 — corrected here (was previously bidder 4/dealer 4,
// matching 4-player, with the other 8 cards each deferred to dealMainHands2Player after the
// opening move). Per the authoritative 2-player deal clarification: both players' full hands are
// dealt up front, and the bidder's opening move is a card played FROM that already-complete
// 12-card hand (leaving 11), not from a still-partial 4-card hand dealt before the rest arrives.
// See dealMainHands2Player below, which now deals only reserves for this reason.
// ---------------------------------------------------------------------------

const CALLER_ELIGIBLE_RANKS: ReadonlySet<Rank> = new Set(['9', '10', 'J', 'Q', 'K']);

function hasCallerEligibleCard(cards: Card[]): boolean {
  return cards.some(c => CALLER_ELIGIBLE_RANKS.has(c.rank));
}

// Guards against a pathological/corrupted deck looping forever. With a real 52-card deck the
// odds of needing this many retries are effectively zero (each retry succeeds with ~87% odds).
const MAX_CALLER_ELIGIBILITY_SHUFFLE_ATTEMPTS = 10_000;

/**
 * Reshuffles the 52 physical cards passed in until the FIRST 4 cards dealt to the bidder contain
 * at least one 9–13 card, per the frozen "IMPORTANT NEW DEAL RULE" — always exactly 4, regardless
 * of the bidder's eventual total hand size (4 in 4-player mode, 12 in 2-player mode). This is
 * deliberate: those first 4 are the only cards the bidder actually looks at before calling — in
 * 4-player mode that's their whole hand; in 2-player mode (see the UI's opening-decision reveal)
 * it's the visible subset they call and make their opening move from, with the other 8 not yet
 * looked at. The guarantee is only meaningful if it's scoped to what the bidder can actually see
 * at call time, so this must never be widened to the bidder's full eventual hand size.
 *
 * This is dealer behavior the player never sees — there is no visible redeal, and nothing beyond
 * this 4-card candidate slice is ever inspected or committed during a retry. Only once a valid
 * slice is found does dealing of the floor, dealer, and remainder proceed, from whatever is left
 * in that same accepted shuffle. This deliberately avoids dealing the full opening state and
 * discarding it — each retry only shuffles and peeks at 4 cards.
 */
function shuffleUntilCallerEligible(deck: Card[]): Card[] {
  for (let attempt = 0; attempt < MAX_CALLER_ELIGIBILITY_SHUFFLE_ATTEMPTS; attempt++) {
    const candidate = shuffleDeck(deck);
    if (hasCallerEligibleCard(candidate.slice(0, 4))) return candidate;
  }
  throw new Error(
    `Could not find a caller-eligible shuffle after ${MAX_CALLER_ELIGIBILITY_SHUFFLE_ATTEMPTS} attempts — ` +
    'this should be statistically impossible with a genuine 52-card deck; check for deck corruption.'
  );
}

/**
 * Deals the opening hands and sets bidderId, moving phase 'dealing' -> 'bidding'.
 *
 * 4-player: 4 to the bidder (the player to the dealer's right), 4 face-down to the floor, 4 to
 * the dealer — unchanged from before this correction.
 *
 * 2-player: 12 to the bidder, 4 face-down to the floor, 12 to the dealer — the corrected
 * authoritative 2-player deal (see the block comment above this section). This leaves deck=24
 * (52 - 12 - 4 - 12), which dealMainHands2Player consumes entirely as the two 12-card reserves.
 *
 * Dealer identity is passed explicitly (Section 7) — never inferred from hand size or state.
 *
 * Expects state.deck to contain the 52 canonical physical cards (any order — this function owns
 * the actual randomizing shuffle itself, per the caller-eligibility rule below, so any order the
 * caller passes in is not preserved).
 *
 * Per the frozen "IMPORTANT NEW DEAL RULE": the bidder's opening hand is guaranteed to contain at
 * least one 9–13 card before anything else is dealt. This is enforced by silently reshuffling
 * only until the bidder's slice qualifies — never by dealing the whole opening state and throwing
 * it away. No player ever sees this happen; it is dealer behavior, not a player decision.
 */
export function dealOpeningHands(state: GameState, dealerId: string): GameState {
  requirePhase(state, 'dealing');
  if (state.deck.length !== 52) {
    throw new Error(`dealOpeningHands expects a full 52-card deck; found ${state.deck.length}.`);
  }
  getPlayer(state, dealerId); // throws if dealerId is not a real player
  const bidderId = nextPlayerId(state, dealerId);

  const bidderAndDealerHandSize = state.mode === '2player' ? 12 : 4;

  const eligibleShuffle = shuffleUntilCallerEligible(state.deck);
  let working: GameState = { ...state, deck: eligibleShuffle };

  const bidderDraw = takeFromDeck(working, bidderAndDealerHandSize);
  working = bidderDraw.state;
  working = updatePlayer(working, bidderId, { hand: [...getPlayer(working, bidderId).hand, ...bidderDraw.cards] });

  const floorDraw = takeFromDeck(working, 4);
  working = floorDraw.state;
  working = { ...working, floor: { ...working.floor, loose: [...working.floor.loose, ...floorDraw.cards] } };

  const dealerDraw = takeFromDeck(working, bidderAndDealerHandSize);
  working = dealerDraw.state;
  working = updatePlayer(working, dealerId, { hand: [...getPlayer(working, dealerId).hand, ...dealerDraw.cards] });

  return { ...working, bidderId, bidValue: null, phase: 'bidding' };
}

// ---------------------------------------------------------------------------
// D. Bid state (Section 6.D)
// ---------------------------------------------------------------------------

/**
 * Stores the bidder's announced value. Deliberately minimal: this checks only what's needed
 * to protect the state transition (right player, right phase, a plausible 9–13 integer).
 *
 * OUT OF SCOPE for Ingredient 2, on purpose: verifying the bidder actually holds a card of
 * this value, and the "redeal if no valid bid exists" rule. Both are full bid-legality logic,
 * which belongs to a later ingredient per the frozen contract (Section 6.D).
 */
export function submitBid(state: GameState, playerId: string, value: number): GameState {
  requirePhase(state, 'bidding');
  if (playerId !== state.bidderId) {
    throw new Error(`Only the bidder (${state.bidderId}) may bid; got ${playerId}.`);
  }
  if (!Number.isInteger(value) || value < 9 || value > 13) {
    throw new Error('Bid value must be an integer from 9 to 13.');
  }
  return { ...state, bidValue: value };
}

// ---------------------------------------------------------------------------
// E. Reveal floor (Section 6.E)
// ---------------------------------------------------------------------------

/** Phase transition only — 'bidding' -> 'revealing'. Moves no physical cards. */
export function revealFloor(state: GameState): GameState {
  requirePhase(state, 'bidding');
  if (state.bidValue === null) {
    throw new Error('Cannot reveal the floor before a bid has been made.');
  }
  return { ...state, phase: 'revealing' };
}

// ---------------------------------------------------------------------------
// F. Opening card movement (Section 6.F) — physical movement ONLY
// ---------------------------------------------------------------------------

/**
 * Moves the bidder's chosen opening card out of their hand and onto the floor as a loose card.
 * This is the ONLY physical movement Ingredient 2 performs for the opening play.
 *
 * Per explicit Product Owner direction: this must stay honest physical movement only. It does
 * NOT decide build, capture, or throw, does NOT create a House, and does NOT move anything into
 * `captured`. Those are rule decisions for a later ingredient.
 */
export function moveOpeningCard(state: GameState, cardId: string): GameState {
  requirePhase(state, 'revealing');
  if (!state.bidderId) throw new Error('No bidder is set.');
  const bidder = getPlayer(state, state.bidderId);
  const card = bidder.hand.find(c => c.id === cardId);
  if (!card) throw new Error(`Card ${cardId} is not in the bidder's hand.`);

  const next = updatePlayer(state, state.bidderId, { hand: bidder.hand.filter(c => c.id !== cardId) });
  return {
    ...next,
    floor: { ...next.floor, loose: [...next.floor.loose, card] },
    phase: 'opening'
  };
}

// ---------------------------------------------------------------------------
// G. Main deal + reserves (Section 6.G) — packets of four
// ---------------------------------------------------------------------------

/**
 * ASSUMPTION FLAGGED FOR PRODUCT OWNER CONFIRMATION — NOT APPROVED (per Section 12 stop
 * condition: "uncertainty about exact packet recipient order"):
 *
 * The frozen contract specifies final card counts and requires dealing in packets of four, but
 * does not specify the literal turn-by-turn order packets are handed out in. Since the deck is
 * already fully shuffled before this point, the interleave order has no effect on fairness or
 * on which cards end up where in aggregate — only on the cosmetic sequence of who receives
 * which packet when. This currently defaults to round-robin in seating order starting from the
 * bidder, skipping any recipient once they've reached their target packet count.
 *
 * This is explicitly NOT approved by the Product Owner and must not be treated as frozen or
 * authoritative. Do not silently change it, and do not silently start treating it as settled.
 */
function dealPacketsInOrder(
  state: GameState,
  recipients: { playerId: string; packetsNeeded: number }[],
  field: 'hand' | 'reserve'
): GameState {
  let working = state;
  const remaining = new Map(recipients.map(r => [r.playerId, r.packetsNeeded]));
  let dealtSomething = true;
  while (dealtSomething) {
    dealtSomething = false;
    for (const { playerId } of recipients) {
      const need = remaining.get(playerId) ?? 0;
      if (need <= 0) continue;
      const draw = takeFromDeck(working, 4);
      working = draw.state;
      const player = getPlayer(working, playerId);
      working = updatePlayer(working, playerId, { [field]: [...player[field], ...draw.cards] } as Partial<Player>);
      remaining.set(playerId, need - 1);
      dealtSomething = true;
    }
  }
  return working;
}

/**
 * ASSUMPTION FLAGGED FOR PRODUCT OWNER CONFIRMATION — NOT APPROVED (same status as the packet
 * order assumption above, per Section 12's stop condition): the frozen Combine/Cement contract
 * requires 4-player Baazi to have side-aware ownership and key-responsibility (partnerships), but
 * nothing has ever specified which seats are partnered. This defaults to the conventional
 * "opposite seats" pairing (players[0]+players[2], players[1]+players[3]) — the same convention
 * already used independently in this project's earlier prototype (game.ts's teamIdFor). Applied
 * only once per game (skipped when state.teams is already populated), so partnerships stay fixed
 * across every subsequent hand's re-deal rather than being silently reassigned. This is
 * explicitly NOT approved and must not be treated as frozen or authoritative — it exists so a
 * 4-player game has *some* valid team assignment rather than none, since legalMoves.ts's
 * side-aware rules now fail loudly (rather than silently guessing) when state.teams is missing.
 */
function assignDefaultTeamsIfMissing(state: GameState): GameState {
  if (state.teams.length > 0 || state.players.length !== 4) return state;
  const [a, b, c, d] = state.players;
  const teams: Team[] = [
    { id: 'team-0', name: 'Team 0', playerIds: [a.id, c.id] },
    { id: 'team-1', name: 'Team 1', playerIds: [b.id, d.id] }
  ];
  return { ...state, teams };
}

/**
 * 4-player main deal. Requires phase 'opening' (i.e. the opening card has already moved).
 * Produces bidder=11, dealer=12, other two players=12 each, deck=0, dealt in packets of four.
 *
 * Deliberately leaves phase at 'opening' rather than advancing it to 'playing' itself. Ingredient
 * 5/6's finalizeOpeningAndAdvance is the sole authoritative place that makes that transition (it
 * also needs every player's hand already dealt before it can correctly find the next player to
 * act) — this function dealing cards and that function deciding when play formally begins are
 * different responsibilities, and only one of them should own the phase change. Found and fixed
 * during Ingredient 8's orchestration work: no prior test ever chained these two functions
 * together, so this conflict (both requiring AND producing phase 'opening'/'playing') had never
 * been exercised before.
 */
export function dealMainHands4Player(state: GameState, dealerId: string): GameState {
  requirePhase(state, 'opening');
  if (!state.bidderId) throw new Error('No bidder is set.');
  if (state.players.length !== 4) {
    throw new Error(`dealMainHands4Player expects exactly 4 players; found ${state.players.length}.`);
  }
  const others = state.players.map(p => p.id).filter(id => id !== dealerId && id !== state.bidderId);
  if (others.length !== 2) {
    throw new Error('Could not identify the two non-bidder, non-dealer players.');
  }
  const dealt = dealPacketsInOrder(
    assignDefaultTeamsIfMissing(state),
    [
      { playerId: state.bidderId, packetsNeeded: 2 }, // 3 + 8 = 11
      { playerId: dealerId, packetsNeeded: 2 }, // 4 + 8 = 12
      { playerId: others[0], packetsNeeded: 3 }, // 0 + 12 = 12
      { playerId: others[1], packetsNeeded: 3 } // 0 + 12 = 12
    ],
    'hand'
  );
  return { ...dealt, phase: 'opening' };
}

/**
 * 2-player reserves. Requires phase 'opening'.
 *
 * Per the corrected authoritative 2-player deal (see the block comment above dealOpeningHands),
 * both players' active hands are now dealt IN FULL by dealOpeningHands, before the opening move —
 * bidder=12, dealer=12, and after the bidder's opening move (moveOpeningCard, already applied by
 * the time this runs) bidder=11, dealer=12. There is no longer a separate "main hand" packet to
 * deal here: this function's only remaining job is the two 12-card reserves, dealt from whatever
 * is left in the deck (24 cards — exactly 2×12, since dealOpeningHands already consumed 12+4+12).
 * Reserve swapping is NOT implemented — reserves are only created here, per Section 6.D of the
 * clarification doc / Section 3 of the final contract.
 *
 * Kept as its own function (rather than folded into dealOpeningHands) because it is called at a
 * different point in the round lifecycle — after the opening action, from the same
 * `dealMainHands` dispatch point roundOrchestrator.ts already uses for both game modes — even
 * though, for 2-player, no hand cards move here anymore.
 *
 * Deliberately leaves phase at 'opening' rather than advancing it to 'playing' itself — see the
 * matching note on dealMainHands4Player for why (Ingredient 5/6's finalizeOpeningAndAdvance is
 * the sole authoritative place that makes that transition).
 */
export function dealMainHands2Player(state: GameState, dealerId: string): GameState {
  requirePhase(state, 'opening');
  if (!state.bidderId) throw new Error('No bidder is set.');
  if (state.players.length !== 2) {
    throw new Error(`dealMainHands2Player expects exactly 2 players; found ${state.players.length}.`);
  }
  const afterReserve = dealPacketsInOrder(
    state,
    [
      { playerId: state.bidderId, packetsNeeded: 3 }, // reserve = 12
      { playerId: dealerId, packetsNeeded: 3 } // reserve = 12
    ],
    'reserve'
  );
  return { ...afterReserve, phase: 'opening' };
}

// ---------------------------------------------------------------------------
// Card-accounting invariant (Section 6 / Section 9) — for tests, not gameplay.
// ---------------------------------------------------------------------------

interface LocatedCard {
  card: Card;
  location: string;
}

const CANONICAL_DECK_IDS = new Set(createDeck().map(c => c.id));

/** Every physical card currently in the game, tagged with exactly where it was found. */
function collectLocatedCards(state: GameState): LocatedCard[] {
  const located: LocatedCard[] = [];
  state.deck.forEach(card => located.push({ card, location: 'deck' }));
  state.floor.loose.forEach(card => located.push({ card, location: 'floor.loose' }));
  state.floor.houses.forEach(house => {
    house.cards.forEach(card => located.push({ card, location: `floor.houses[${house.id}]` }));
  });
  state.players.forEach(player => {
    player.hand.forEach(card => located.push({ card, location: `player[${player.id}].hand` }));
    player.reserve.forEach(card => located.push({ card, location: `player[${player.id}].reserve` }));
    player.captured.forEach(card => located.push({ card, location: `player[${player.id}].captured` }));
  });
  return located;
}

/** Every physical card currently in the game, across every location, exactly once each. */
export function collectAllCards(state: GameState): Card[] {
  return collectLocatedCards(state).map(l => l.card);
}

/**
 * Throws if the physical-card invariant is violated anywhere in the state. Checks, in order:
 *   1. Exactly 52 cards total, across every location combined.
 *   2. Every card id is unique — no id appears twice anywhere.
 *   3. No card id appears in more than one physical location (a stronger, separately-reported
 *      version of #2 that names the two conflicting locations, since a card silently existing
 *      in two places at once is a distinct failure mode from a card being duplicated in place).
 *   4. The set of ids present exactly matches the canonical 52-card deck's ids — catches a
 *      fabricated or corrupted card id even if the total count and uniqueness happen to hold.
 */
export function assertCardInvariant(state: GameState): void {
  const located = collectLocatedCards(state);

  if (located.length !== 52) {
    throw new Error(`Expected 52 physical cards, found ${located.length}.`);
  }

  const seenAt = new Map<string, string>();
  for (const { card, location } of located) {
    const priorLocation = seenAt.get(card.id);
    if (priorLocation) {
      throw new Error(
        `Card id "${card.id}" appears in more than one physical location: "${priorLocation}" and "${location}".`
      );
    }
    seenAt.set(card.id, location);
  }

  const foundIds = new Set(seenAt.keys());
  for (const id of CANONICAL_DECK_IDS) {
    if (!foundIds.has(id)) {
      throw new Error(`Card id "${id}" from the canonical 52-card deck is missing from the game state.`);
    }
  }
  for (const id of foundIds) {
    if (!CANONICAL_DECK_IDS.has(id)) {
      throw new Error(`Card id "${id}" is not part of the canonical 52-card deck.`);
    }
  }
}
