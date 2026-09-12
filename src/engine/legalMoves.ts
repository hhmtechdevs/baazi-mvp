import type { Card, CaptureTarget, GameState, House, Player, Rank } from '../types';

// ---------------------------------------------------------------------------
// Small internal helpers (deliberately re-declared here rather than imported
// from Ingredient 2/3 files, to avoid touching or coupling to frozen modules).
// ---------------------------------------------------------------------------

const RANK_VALUES: Record<Rank, number> = {
  A: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13
};

function rankValue(rank: Rank): number {
  return RANK_VALUES[rank];
}

function getPlayer(state: GameState, playerId: string): Player {
  const player = state.players.find(p => p.id === playerId);
  if (!player) throw new Error(`Unknown player: ${playerId}`);
  return player;
}

const HOUSE_MIN = 9;
const HOUSE_MAX = 13;

// ---------------------------------------------------------------------------
// Side/partner resolution — new for the Combine/Cement architecture. A "side" is the unit that
// ownership and (for Cement) key-responsibility are evaluated against: the player themselves in
// 2-player mode, or their team in 4-player mode.
//
// Deliberately strict in 4-player mode: a player with no team entry means the GameState was
// never properly assigned partnerships, and side-aware rules (Cement's partner-key check, joint
// ownership) cannot be evaluated correctly without that information. Silently treating a missing
// team as "this player is their own side" would make broken 4-player state quietly masquerade as
// valid 2-player semantics — exactly the kind of latent bug this throws to prevent. Ingredient
// 2's dealMainHands4Player now populates state.teams for this reason (see deal.ts); any caller
// that reaches this with 4-player mode and no team for the player has an invalid GameState.
// ---------------------------------------------------------------------------

function sideOf(state: GameState, playerId: string): string {
  if (state.mode === '2player') return playerId;
  const team = state.teams.find(t => t.playerIds.includes(playerId));
  if (!team) {
    throw new Error(
      `Invalid GameState: mode is '4player' but no team entry contains player ${playerId}. ` +
      'Side-aware rules (ownership, key responsibility) require state.teams to be populated ' +
      'before evaluating them in 4-player mode.'
    );
  }
  return team.id;
}

/** Other players sharing this player's side (their partner, in 4-player mode). Empty in 2-player mode. */
function teammatesOf(state: GameState, playerId: string): Player[] {
  if (state.mode === '2player') return [];
  const side = sideOf(state, playerId);
  return state.players.filter(p => p.id !== playerId && sideOf(state, p.id) === side);
}

// ---------------------------------------------------------------------------
// Discovered-option types. New, engine-level, additive to the frozen model —
// the frozen types (Card, CaptureTarget, etc.) are reused directly wherever
// possible so a chosen option maps cleanly onto Ingredient 3's OpeningAction.
//
// Build / Cement / Break / MergeFix / AddToFixed are five distinct semantic actions (per the
// frozen Combine architecture) rather than one generic "build" — each carries exactly what
// Ingredient 5 needs to execute mechanically without re-deriving ownership, key-responsibility,
// or absorption itself.
// ---------------------------------------------------------------------------

export interface LegalBuildOption {
  kind: 'build';
  handCardId: string;
  floorCardIds: string[];
  resultingValue: number;
  /** Additional loose-card combinations at this value, folded in automatically once chosen. */
  absorbedLooseCardIds: string[];
  resultingOwnerSides: [string];
}

export interface LegalCementOption {
  kind: 'cement';
  handCardId: string;
  existingHouseId: string;
  floorCardIds: string[];
  resultingValue: number;
  absorbedLooseCardIds: string[];
  /** Which hand held the retained key that made this legal — informational, not a gate. */
  keySatisfiedBy: 'self' | 'partner';
  /** 1 entry if cementer and prior owner share a side, 2 if it crosses sides (joint ownership). */
  resultingOwnerSides: string[];
}

export interface LegalBreakOption {
  kind: 'break';
  handCardId: string;
  existingHouseId: string;
  resultingValue: number;
  absorbedLooseCardIds: string[];
  resultingOwnerSides: [string];
}

export interface LegalMergeFixOption {
  kind: 'mergeFix';
  handCardId: string;
  existingHouseId: string;   // the ordinary house being broken
  targetHouseId: string;     // the pre-existing house at the raised value it merges into
  resultingValue: number;
  absorbedLooseCardIds: string[];
  resultingOwnerSides: [string];
}

export interface LegalAddToFixedOption {
  kind: 'addToFixed';
  handCardId: string;
  existingHouseId: string;   // already isCemented === true
  floorCardIds: string[];
  resultingValue: number;
  absorbedLooseCardIds: string[];
  // no resultingOwnerSides — Add-to-Fixed never changes ownership (frozen rule)
}

export interface LegalCaptureOption {
  kind: 'capture';
  handCardId: string;
  targets: CaptureTarget[];
  /** The total value captured — always equal to the played card's rank value. */
  value: number;
  /** True if taking this capture would leave the floor (loose cards and houses) completely empty. */
  isSeep: boolean;
}

export interface LegalThrowOption {
  kind: 'throw';
  handCardId: string;
}

export type LegalOption =
  | LegalBuildOption
  | LegalCementOption
  | LegalBreakOption
  | LegalMergeFixOption
  | LegalAddToFixedOption
  | LegalCaptureOption
  | LegalThrowOption;

// ---------------------------------------------------------------------------
// Subset-sum enumeration, bounded by target value (never by floor size).
// Card values are 1–13 and every target used here is at most 13, so this
// prunes hard and stays fast regardless of how many loose cards are on the
// floor (a lesson learned the hard way on an earlier, unrelated project:
// enumerating the full powerset of loose cards instead of pruning by
// remaining target hangs the moment a floor grows past ~20 cards).
// ---------------------------------------------------------------------------

function enumerateSubsetsSummingTo(cards: Card[], target: number): Card[][] {
  if (target < 0) return [];
  if (target === 0) return [[]]; // "use no additional cards" is itself a valid, empty combination
  const results: Card[][] = [];
  function backtrack(startIndex: number, remaining: number, chosen: Card[]): void {
    if (remaining === 0) {
      results.push([...chosen]);
      return;
    }
    for (let i = startIndex; i < cards.length; i++) {
      const value = rankValue(cards[i].rank);
      if (value > remaining) continue; // prune: this card alone would overshoot
      chosen.push(cards[i]);
      backtrack(i + 1, remaining - value, chosen);
      chosen.pop();
    }
  }
  backtrack(0, target, []);
  return results;
}

function isSeepAfter(state: GameState, capturedLooseIds: Set<string>, capturedHouseIds: Set<string>): boolean {
  const remainingLoose = state.floor.loose.filter(c => !capturedLooseIds.has(c.id));
  const remainingHouses = state.floor.houses.filter(h => !capturedHouseIds.has(h.id));
  return remainingLoose.length === 0 && remainingHouses.length === 0;
}

// ---------------------------------------------------------------------------
// Maximal non-overlapping combination of "capture units" (each unit: a
// specific set of loose cards summing to the played value). Two units
// conflict if they share any physical card. A single play must gather every
// unit it can reach that doesn't conflict with another chosen unit — you
// cannot leave an independently-reachable, non-conflicting group on the
// floor. Where two units DO conflict (share a card), that is a genuine
// player choice between mutually exclusive alternatives.
//
// This is "find all maximal cliques in the compatibility graph" (equivalently
// all maximal independent sets in the conflict graph) via Bron–Kerbosch with
// pivoting. Units are bounded by the target value (≤13 cards per unit, and in
// practice few units overall for realistic floors), so this stays tractable;
// see the performance test for how it holds up against an adversarial floor.
//
// Reused (not just for captures) by collectAllCompatibleCombinations below, for the identical
// "collect every non-conflicting compatible combination" rule now frozen for Build/Cement/
// MergeFix/Add-to-Fixed absorption too.
// ---------------------------------------------------------------------------

function findMaximalCompatibleGroupSets(groups: Card[][]): Card[][][] {
  const n = groups.length;
  if (n === 0) return [];
  const compatible: Set<number>[] = Array.from({ length: n }, () => new Set());
  for (let i = 0; i < n; i++) {
    const idsI = new Set(groups[i].map(c => c.id));
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const overlaps = groups[j].some(c => idsI.has(c.id));
      if (!overlaps) compatible[i].add(j);
    }
  }

  const results: number[][] = [];
  function bronKerbosch(R: Set<number>, P: Set<number>, X: Set<number>): void {
    if (P.size === 0 && X.size === 0) {
      results.push([...R]);
      return;
    }
    let pivot = -1;
    let bestCount = -1;
    for (const u of [...P, ...X]) {
      const count = [...P].filter(v => compatible[u].has(v)).length;
      if (count > bestCount) { bestCount = count; pivot = u; }
    }
    const candidates = [...P].filter(v => pivot === -1 || !compatible[pivot].has(v));
    const pSet = new Set(P);
    const xSet = new Set(X);
    for (const v of candidates) {
      const newP = new Set([...pSet].filter(u => compatible[v].has(u)));
      const newX = new Set([...xSet].filter(u => compatible[v].has(u)));
      bronKerbosch(new Set([...R, v]), newP, newX);
      pSet.delete(v);
      xSet.add(v);
    }
  }
  bronKerbosch(new Set(), new Set(groups.map((_, i) => i)), new Set());
  return results.map(idxSet => idxSet.map(i => groups[i]));
}

const MAX_TRACTABLE_LOOSE_GROUPS = 1000;

/**
 * The "collect all compatible combinations" rule, per Pagat's own cementing rule and confirmed
 * against its identical mandatory-capture wording: every loose-card combination summing to
 * `target` that doesn't conflict (share a card) with another chosen combination MUST be folded
 * in — never left behind, and never a player choice. But when combinations genuinely conflict
 * (they share a card, so both cannot be taken), that is not an unresolved edge case — it is
 * exactly the same "collect everything, but choose between overlapping alternatives" rule already
 * established for capture (see discoverCaptureOptionsForValue below, and the classic pagat 2+3+6
 * vs 5+6 example this shares its algorithm with). So every maximal non-conflicting combination is
 * returned as its own candidate; the caller turns each into a separate, independently choosable
 * LegalOption, and picking one leaves the other candidates' cards on the floor untouched — the
 * player never gets to combine two conflicting candidates, and never gets to silently drop one
 * without the engine choosing on their behalf. This always returns at least one candidate (the
 * empty list, when nothing loose is reachable at all).
 */
function collectAllCompatibleCombinations(loose: Card[], target: number): Card[][] {
  const groups = enumerateSubsetsSummingTo(loose, target).filter(g => g.length > 0);
  if (groups.length === 0) return [[]];
  if (groups.length > MAX_TRACTABLE_LOOSE_GROUPS) {
    throw new Error(
      `Absorption search found ${groups.length} distinct loose-card groups summing to ${target}, exceeding the ` +
      `safety limit of ${MAX_TRACTABLE_LOOSE_GROUPS}. This floor state needs product/architecture attention ` +
      'rather than a silent hang.'
    );
  }

  const maximalCombinations = findMaximalCompatibleGroupSets(groups);
  const distinctByCardIds = new Map<string, Card[]>();
  for (const combo of maximalCombinations) {
    const cards = combo.flat();
    const key = cards.map(c => c.id).sort().join(',');
    distinctByCardIds.set(key, cards);
  }
  return [...distinctByCardIds.values()];
}

// ---------------------------------------------------------------------------
// Capture discovery for a single hand card, given the exact value it must
// capture (V). Used identically by both opening and normal-play discovery —
// only which cards are allowed to call this, and at what V, differs.
//
// A house's cards are never simultaneously "loose", so a qualifying house
// never conflicts with any loose-card unit or with another qualifying house
// (each house's cards are unique to it). That means every qualifying house
// is appended to every discovered combination unconditionally, and the only
// real combinatorial work is among the loose-card units.
//
// UNCHANGED by the Combine/Cement architecture work — capture is already ownership-blind and
// side-agnostic (frozen earlier), so nothing here needed to change.
// ---------------------------------------------------------------------------

function discoverCaptureOptionsForValue(state: GameState, handCard: Card, value: number): LegalCaptureOption[] {
  const qualifyingHouses = state.floor.houses.filter(h => h.captureValue === value);
  const looseGroups = enumerateSubsetsSummingTo(state.floor.loose, value).filter(g => g.length > 0);

  // SAFETY GUARD — see the large comment on findMaximalCompatibleGroupSets above. Finding all
  // maximal non-overlapping combinations is set-packing (NP-hard in general): empirically, ~400
  // atomic groups resolves in ~30ms, but ~2,000 already takes seconds and ~4,000 hangs. This
  // threshold is chosen well above realistic gameplay floors and well below where it gets slow,
  // so a cluttered-but-normal floor is unaffected, and a truly pathological one fails fast and
  // diagnosably instead of hanging the caller indefinitely. See the Ingredient 4 correction
  // report for why this exists and what would be needed to remove it.
  if (looseGroups.length > MAX_TRACTABLE_LOOSE_GROUPS) {
    throw new Error(
      `Legal move discovery found ${looseGroups.length} distinct loose-card groups summing to ${value}, ` +
      `exceeding the safety limit of ${MAX_TRACTABLE_LOOSE_GROUPS}. Finding all maximal non-overlapping ` +
      'combinations is combinatorially intractable at this scale; this floor state needs product/architecture ' +
      'attention rather than a silent hang.'
    );
  }

  const buildOption = (looseCards: Card[]): LegalCaptureOption => {
    const targets: CaptureTarget[] = [
      ...qualifyingHouses.map(h => ({ type: 'house', houseId: h.id } as CaptureTarget)),
      ...looseCards.map(c => ({ type: 'loose', cardId: c.id } as CaptureTarget))
    ];
    const looseIds = new Set(looseCards.map(c => c.id));
    const houseIds = new Set(qualifyingHouses.map(h => h.id));
    return {
      kind: 'capture',
      handCardId: handCard.id,
      targets,
      value,
      isSeep: isSeepAfter(state, looseIds, houseIds)
    };
  };

  if (looseGroups.length === 0) {
    // Nothing loose to gather. If a house qualifies, it stands as its own complete option
    // (or combines with any other simultaneously-qualifying house — never partially).
    return qualifyingHouses.length > 0 ? [buildOption([])] : [];
  }

  // Every maximal set of mutually non-conflicting loose groups becomes one complete capture
  // option (combined with every qualifying house, which never conflicts with anything).
  const maximalCombinations = findMaximalCompatibleGroupSets(looseGroups);
  return maximalCombinations.map(combo => buildOption(combo.flat()));
}

// ---------------------------------------------------------------------------
// Build discovery for the OPENING move only (Ingredient 3's exclusive caller). The opening floor
// has just been revealed with no houses on it yet, so it can never encounter an existing house —
// Cement/Break/MergeFix/Add-to-Fixed are structurally impossible on the very first move of a
// hand. Left exactly as before: unchanged, self-only retention, no house-awareness needed.
// ---------------------------------------------------------------------------

function discoverBuildOptionsForValue(
  hand: Card[],
  floorLoose: Card[],
  handCard: Card,
  houseValue: number,
  bidderId: string
): LegalBuildOption[] {
  const needed = houseValue - rankValue(handCard.rank);
  if (needed < 0) return [];

  const combos = enumerateSubsetsSummingTo(floorLoose, needed);
  const handAfterPlaying = hand.filter(c => c.id !== handCard.id);
  const retains = handAfterPlaying.some(c => rankValue(c.rank) === houseValue);
  if (!retains) return [];

  return combos.map(combo => ({
    kind: 'build' as const,
    handCardId: handCard.id,
    floorCardIds: combo.map(c => c.id),
    resultingValue: houseValue,
    absorbedLooseCardIds: [], // the opening floor has just 4 cards and no pre-existing houses
    resultingOwnerSides: [bidderId]
  }));
}

// ---------------------------------------------------------------------------
// NORMAL PLAY house-action discovery — Build / Cement / Break / MergeFix / Add-to-Fixed.
//
// Two independent mechanics, matching the frozen Combine architecture:
//
//   PASS A ("landing" — Build/Cement/Add-to-Fixed): the played card, optionally combined with a
//   floor-loose combo, sums to exactly some value V. What already sits at V decides the action:
//   nothing -> Build, an ordinary house -> Cement, an already-cemented house -> Add-to-Fixed.
//
//   PASS B ("raising" — Break/MergeFix): the played card is added directly onto an existing
//   ORDINARY house, raising its value by the card's own rank. What already sits at the new value
//   decides the action: nothing -> Break, another ordinary house -> MergeFix. A cemented house
//   can never occupy the destination (cemented houses cannot change value — frozen), so raising
//   onto one is simply not legal.
//
// Both passes end by running the same collectAllCompatibleCombinations absorption over whatever
// loose cards remain, per the frozen "choose the action, then all compatible combinations are
// collected automatically" rule — uniformly, not just for fresh Build. When that absorption
// itself has multiple non-overlapping alternatives, each becomes its own discovered option here
// (see collectAllCompatibleCombinations) — never merged, never silently picked.
// ---------------------------------------------------------------------------

function discoverLandingOptionsForCard(
  state: GameState,
  actingPlayerId: string,
  hand: Card[],
  handCard: Card,
  houseValue: number
): (LegalBuildOption | LegalCementOption | LegalAddToFixedOption)[] {
  const needed = houseValue - rankValue(handCard.rank);
  if (needed < 0) return [];

  const combos = enumerateSubsetsSummingTo(state.floor.loose, needed);
  const houseAtValue = state.floor.houses.find(h => h.captureValue === houseValue);
  const results: (LegalBuildOption | LegalCementOption | LegalAddToFixedOption)[] = [];

  for (const combo of combos) {
    const comboIds = new Set(combo.map(c => c.id));
    const remainingLoose = state.floor.loose.filter(c => !comboIds.has(c.id));
    const handAfterPlaying = hand.filter(c => c.id !== handCard.id);

    if (!houseAtValue) {
      // BUILD — the acting player's own key only (frozen).
      const retains = handAfterPlaying.some(c => rankValue(c.rank) === houseValue);
      if (!retains) continue;

      for (const absorbed of collectAllCompatibleCombinations(remainingLoose, houseValue)) {
        results.push({
          kind: 'build',
          handCardId: handCard.id,
          floorCardIds: combo.map(c => c.id),
          resultingValue: houseValue,
          absorbedLooseCardIds: absorbed.map(c => c.id),
          resultingOwnerSides: [actingPlayerId]
        });
      }
    } else if (!houseAtValue.isCemented) {
      // CEMENT — the acting player's own key, or their partner's (frozen).
      const selfRetains = handAfterPlaying.some(c => rankValue(c.rank) === houseValue);
      const partnerRetains = teammatesOf(state, actingPlayerId).some(p => p.hand.some(c => rankValue(c.rank) === houseValue));
      if (!selfRetains && !partnerRetains) continue;

      const beforeSide = sideOf(state, houseAtValue.ownerSides[0]);
      const cementerSide = sideOf(state, actingPlayerId);
      const resultingOwnerSides = [...new Set([beforeSide, cementerSide])].sort();

      for (const absorbed of collectAllCompatibleCombinations(remainingLoose, houseValue)) {
        results.push({
          kind: 'cement',
          handCardId: handCard.id,
          existingHouseId: houseAtValue.id,
          floorCardIds: combo.map(c => c.id),
          resultingValue: houseValue,
          absorbedLooseCardIds: absorbed.map(c => c.id),
          keySatisfiedBy: selfRetains ? 'self' : 'partner',
          resultingOwnerSides
        });
      }
    } else {
      // ADD-TO-FIXED — ownership never changes (frozen). EXPLICIT PRODUCT OWNER RULE
      // (Baazi-specific — Pagat's own policy explicitly allows agreed local/house-rule variations,
      // pagat.com/policy.html; we are not claiming Pagat or any other source states this exact
      // rule, only that ZK-Seep's SeepRules.md corroborates Add-to-Fixed and eventual pickup as
      // distinct concepts worth keeping separate here):
      //
      // This is a RETAINS check — the same concept already governing Build and Cement above, just
      // extended to Add-to-Fixed — NOT a "Capture wins a tie" strategic preference. When the
      // played card ALONE (no floor combo — needed === 0) matches the fixed house's value, using
      // it to reinforce the house is illegal UNLESS the player's hand still holds ANOTHER card of
      // that same value afterward. The reasoning: you cannot make/add to a pukka house that you
      // have no remaining matching card to eventually collect — with only one matching card, using
      // it to reinforce would permanently strand your own ability to ever capture that house, so
      // it must capture instead. With a second matching card in hand, reinforcing with one while
      // keeping the other in reserve is a legitimate, still-available choice.
      //
      // Only applies when needed === 0 (the card alone matches, with no floor combo). A
      // non-matching card that only reaches the house's value via a floor combo (e.g. 5 + a loose
      // 6 = 11) never had a competing Capture option for THAT card in the first place (normal-play
      // Capture always targets the played card's own rank — see discoverNormalOptionsForCard —
      // which here differs from houseValue), so Add-to-Fixed remains fully legal in that case
      // regardless of what else is in hand.
      const retainsAnother = handAfterPlaying.some(c => rankValue(c.rank) === houseValue);
      if (needed === 0 && !retainsAnother) continue;
      for (const absorbed of collectAllCompatibleCombinations(remainingLoose, houseValue)) {
        results.push({
          kind: 'addToFixed',
          handCardId: handCard.id,
          existingHouseId: houseAtValue.id,
          floorCardIds: combo.map(c => c.id),
          resultingValue: houseValue,
          absorbedLooseCardIds: absorbed.map(c => c.id)
        });
      }
    }
  }
  return results;
}

function discoverRaisingOptionsForCard(
  state: GameState,
  actingPlayerId: string,
  hand: Card[],
  handCard: Card
): (LegalBreakOption | LegalMergeFixOption)[] {
  const results: (LegalBreakOption | LegalMergeFixOption)[] = [];
  const cardValue = rankValue(handCard.rank);

  for (const house of state.floor.houses) {
    if (house.isCemented) continue; // cemented houses cannot change value — frozen
    // Cannot break your own individual house; your partner's is explicitly allowed — frozen.
    if (house.ownerSides[0] === actingPlayerId) continue;

    const newValue = house.captureValue + cardValue;
    if (newValue > HOUSE_MAX) continue;

    const handAfterPlaying = hand.filter(c => c.id !== handCard.id);
    const retains = handAfterPlaying.some(c => rankValue(c.rank) === newValue);
    if (!retains) continue;

    const target = state.floor.houses.find(h => h.id !== house.id && h.captureValue === newValue);
    if (target && target.isCemented) continue; // cannot raise into an already-cemented house

    for (const absorbed of collectAllCompatibleCombinations(state.floor.loose, newValue)) {
      if (target) {
        results.push({
          kind: 'mergeFix',
          handCardId: handCard.id,
          existingHouseId: house.id,
          targetHouseId: target.id,
          resultingValue: newValue,
          absorbedLooseCardIds: absorbed.map(c => c.id),
          resultingOwnerSides: [actingPlayerId]
        });
      } else {
        results.push({
          kind: 'break',
          handCardId: handCard.id,
          existingHouseId: house.id,
          resultingValue: newValue,
          absorbedLooseCardIds: absorbed.map(c => c.id),
          resultingOwnerSides: [actingPlayerId]
        });
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// NORMAL PLAY discovery: house-landing (Build/Cement/Add-to-Fixed) and house-raising
// (Break/MergeFix) actions are always available alongside Capture — Build/Combine is a strategic
// player CHOICE, never mandatory (frozen), so its presence never suppresses Capture or Throw.
// Per the frozen mandatory-capture rule, Throw is only suppressed when a Capture exists.
// ---------------------------------------------------------------------------

function discoverNormalOptionsForCard(
  state: GameState,
  actingPlayerId: string,
  hand: Card[],
  handCard: Card
): LegalOption[] {
  const options: LegalOption[] = [];

  for (let houseValue = HOUSE_MIN; houseValue <= HOUSE_MAX; houseValue++) {
    options.push(...discoverLandingOptionsForCard(state, actingPlayerId, hand, handCard, houseValue));
  }
  options.push(...discoverRaisingOptionsForCard(state, actingPlayerId, hand, handCard));

  const captureOptions = discoverCaptureOptionsForValue(state, handCard, rankValue(handCard.rank));
  options.push(...captureOptions);

  if (captureOptions.length === 0) {
    options.push({ kind: 'throw', handCardId: handCard.id });
  }

  return options;
}

// ---------------------------------------------------------------------------
// OPENING discovery: strict Build > Capture > Throw priority (Baazi-frozen
// rule), locked to the single announced bid value. This is a whole-hand
// determination — whether build is mandated depends on the ENTIRE hand and
// floor, not just the one card being queried — so this always computes
// across every hand card first, then reports each card's slice of it.
//
// UNCHANGED by the Combine/Cement architecture: the opening floor never has houses on it, so
// house-awareness is structurally irrelevant here. `resultingOwnerSides` on the Build options it
// produces is overwritten below to the bidder's own id (discoverBuildOptionsForValue's
// placeholder exists purely so its return type matches the shared LegalBuildOption shape).
// ---------------------------------------------------------------------------

function discoverOpeningOptionsForHand(state: GameState, bidderId: string, hand: Card[]): Record<string, LegalOption[]> {
  const bidValue = state.bidValue as number;
  const byCard: Record<string, LegalOption[]> = {};
  for (const card of hand) byCard[card.id] = [];

  // Tier 1: build, at exactly the bid value, across every hand card.
  let anyBuild = false;
  for (const card of hand) {
    const builds = discoverBuildOptionsForValue(hand, state.floor.loose, card, bidValue, bidderId);
    if (builds.length) {
      byCard[card.id].push(...builds);
      anyBuild = true;
    }
  }
  if (anyBuild) return byCard; // Build Priority: capture and throw are not legal for anyone

  // Tier 2: capture, only for the card(s) whose rank equals the bid value.
  let anyCapture = false;
  const bidValueCards = hand.filter(c => rankValue(c.rank) === bidValue);
  for (const card of bidValueCards) {
    const captures = discoverCaptureOptionsForValue(state, card, bidValue);
    if (captures.length) {
      byCard[card.id].push(...captures);
      anyCapture = true;
    }
  }
  if (anyCapture) return byCard; // capture takes priority over throw once build is unavailable

  // Tier 3: throw, only for the bid-value card(s), only once neither build nor capture exists.
  for (const card of bidValueCards) {
    byCard[card.id].push({ kind: 'throw', handCardId: card.id });
  }
  return byCard;
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * True when `playerId` is currently making the opening decision: a bid exists, the floor has
 * been revealed, the opening action has not yet been taken, and this is the caller/bidder.
 * Every other situation is treated as normal play (no bid-value lock, no Build Priority gate).
 */
export function isOpeningDecision(state: GameState, playerId: string): boolean {
  return state.phase === 'revealing' && state.bidderId === playerId && state.bidValue !== null;
}

/**
 * Discovers every distinct legal option for every card in `playerId`'s hand, with no ranking,
 * scoring, or recommendation. A card with no legal action maps to an empty array. This is a
 * pure query — it does not mutate state and does not decide anything on the player's behalf.
 */
export function discoverLegalOptionsForHand(state: GameState, playerId: string): Record<string, LegalOption[]> {
  const player = getPlayer(state, playerId);
  if (isOpeningDecision(state, playerId)) {
    return discoverOpeningOptionsForHand(state, playerId, player.hand);
  }
  const byCard: Record<string, LegalOption[]> = {};
  for (const card of player.hand) {
    byCard[card.id] = discoverNormalOptionsForCard(state, playerId, player.hand, card);
  }
  return byCard;
}

/** Discovers every distinct legal option for one specific hand card. */
export function discoverLegalOptions(state: GameState, playerId: string, handCardId: string): LegalOption[] {
  return discoverLegalOptionsForHand(state, playerId)[handCardId] ?? [];
}
