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
/**
 * Teammates, where the table can actually say who they are.
 *
 * `sideOf` refuses a 4-player state whose teams are not populated — rightly, because ownership
 * decisions must never be guessed at. But a key check only ASKS whether a partner can help, and a
 * state with no teams recorded has no partner to offer. Answering "nobody" there is both honest
 * and the safe direction: it can only withhold a move, never permit one.
 */
/**
 * A player's side, falling back to the player themselves when the table has not recorded teams.
 *
 * `sideOf` rightly refuses to guess for ownership decisions. The questions below — "does my side
 * already own this house" and "who owns it afterwards" — need an answer on every discovery pass,
 * including on partially-built states, so they use this instead of taking the table down.
 */
function sideOrSelf(state: GameState, playerId: string): string {
  if (state.mode === '2player') return playerId;
  return state.teams.find(t => t.playerIds.includes(playerId))?.id ?? playerId;
}

/** The sides owning a house, resolved the same tolerant way. */
function owningSidesTolerant(state: GameState, house: House): Set<string> {
  return new Set(house.ownerSides.map(owner => sideOrSelf(state, owner)));
}

function knownTeammatesOf(state: GameState, playerId: string): Player[] {
  if (state.mode === '2player') return [];
  if (!state.teams.some(t => t.playerIds.includes(playerId))) return [];
  return teammatesOf(state, playerId);
}

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
  /**
   * Adding to a house your side does not own buys you INTO it: one entry when your side already
   * owned it, two when this move joins them (Pagat — adding to an opponent's house makes you a
   * second owner). Revised 2026-10-07; this used to be absent, Add-to-Fixed having never changed
   * ownership.
   */
  resultingOwnerSides: string[];
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

/**
 * NO CARD MAY FORM A HOUSE BY ITSELF — including a King (Product Owner, post-freeze).
 *
 * A card played from hand with nothing from the floor is simply a LOOSE card: anyone may capture
 * it, and it only becomes a house when someone later builds on it (9 + 2 = 11) as an explicit
 * action. This was first corrected for 9/10/J/Q — build discovery used to treat "use no floor
 * cards" as a valid combination for any value, and 44% of all houses built in auto-played rounds
 * were single 9/10/J/Q cards. A King was kept as a Baazi-specific exception at the time, on the
 * reasoning that a King is already worth 13 and can never be raised, so declaring one alone was a
 * complete house. That exception has now been removed as well: a King played on its own is a loose
 * card like any other, and no BUILD option may be offered merely because a King could stand as a
 * 13-house. Everything else about Kings is unchanged — capturing with one, capturing a loose one,
 * and building a 13 out of a King plus floor cards all work exactly as before.
 *
 * Enforced in two places, both below: opening build discovery and normal-play build discovery
 * (Ingredient 3's opening-build validator applies the same rule directly).
 */

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
  //
  // DEDUPED BY THE CARDS TAKEN, not by the grouping that reached them. Two different partitions can
  // cover exactly the same cards: a 3 played over 2♦ A♠ 2♠ A♥ can pair 2♦+A♠ with 2♠+A♥, or 2♦+A♥
  // with 2♠+A♠ — different groupings, identical capture. The grouping is an implementation detail
  // of the search; what a player chooses between is the set of cards they pick up, so offering the
  // same set twice is offering the same move twice. collectAllCompatibleCombinations has always
  // deduped this way; capture discovery did not, which is the duplicate-option bug seen roughly
  // once per 120,000 option lists in seeded play.
  const distinctByCardsTaken = new Map<string, Card[]>();
  for (const combo of findMaximalCompatibleGroupSets(looseGroups)) {
    const cards = combo.flat();
    distinctByCardsTaken.set(cards.map(c => c.id).sort().join(','), cards);
  }
  return [...distinctByCardsTaken.values()].map(buildOption);
}

// ---------------------------------------------------------------------------
// Build discovery for the OPENING move only (Ingredient 3's exclusive caller). The opening floor
// has just been revealed with no houses on it yet, so it can never encounter an existing house —
// Cement/Break/MergeFix/Add-to-Fixed are structurally impossible on the very first move of a
// hand. Self-only retention, no house-awareness needed.
//
// ABSORPTION (fixed 2026-10-07). This function used to hardcode `absorbedLooseCardIds: []`, on the
// reasoning that the opening floor holds no pre-existing houses. That reasoning is sound for the
// house-based actions and wrong for absorption: incorporating OTHER loose groups already worth the
// called value has nothing to do with houses, and a four-card floor leaves ample room for one.
// Reported from live play — called 13 over a floor of 8 5 6 Q, the 7 took the 6 and left the 8 and
// 5 lying there. The frozen Combine rule is that every compatible non-overlapping group that can be
// incorporated must be, so this now runs the same collectAllCompatibleCombinations pass normal play
// does.
//
// DELIBERATELY NOT CHANGED: the `combo.length > 0` filter below. Normal play permits a build whose
// played card is laid down with a group swept in alongside it (J with 5 + 6 beside it); the opening
// forbids it. That divergence is real, is documented in OPENING_BUILD_ABSORPTION.md, and is a
// separate rules decision that is NOT being taken here — see the pinned test in
// reportedPositions.test.ts.
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

  // A build always has to combine with something on the floor; no rank stands alone. Keeping this
  // filter is what preserves the opening's existing lay-alongside behaviour — see the header.
  const combos = enumerateSubsetsSummingTo(floorLoose, needed).filter(combo => combo.length > 0);
  const handAfterPlaying = hand.filter(c => c.id !== handCard.id);
  const retains = handAfterPlaying.some(c => rankValue(c.rank) === houseValue);
  if (!retains) return [];

  const options: LegalBuildOption[] = [];
  for (const combo of combos) {
    const comboIds = new Set(combo.map(c => c.id));
    const remainingLoose = floorLoose.filter(c => !comboIds.has(c.id));

    // Exactly the pass normal-play build discovery runs: every maximal set of non-overlapping
    // groups still worth the house value. Returns [[]] when there is nothing to take, so a build
    // with nothing to absorb still yields its single option.
    for (const absorbed of collectAllCompatibleCombinations(remainingLoose, houseValue)) {
      options.push({
        kind: 'build' as const,
        handCardId: handCard.id,
        floorCardIds: combo.map(c => c.id),
        resultingValue: houseValue,
        absorbedLooseCardIds: absorbed.map(c => c.id),
        resultingOwnerSides: [bidderId]
      });
    }
  }
  return options;
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
        // A new house may not consist of the played card ALONE — any card laid down by itself,
        // King included, stays a loose card. Floor cards can join it two ways, and either counts:
        // summed WITH the played card (the combo: 5 + 6 = 11), or swept in ALONGSIDE it as a group
        // already worth the value (a J with a 5+6 beside it is the house J + 5 + 6). Only when both
        // are empty is it forbidden.
        //
        // Checked here, per absorption alternative, and deliberately not on the shared `combos`
        // list: an earlier draft filtered empty combos outright and wrongly removed J + 5 + 6 —
        // caught by frozen test 6d. Cement / Add-to-Fixed below land a card on an EXISTING house and
        // are a different action entirely, so they are untouched.
        if (combo.length === 0 && absorbed.length === 0) continue;

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
      // WHOSE HOUSE IS IT (Product Owner, 2026-10-07; corroborated by Pagat's Seep page).
      //
      // Your side already owns it → add freely. The owner is already obliged to hold the key, so
      // the side's claim is established, and it is visible on the table rather than hidden in a
      // teammate's hand.
      //
      // It is somebody else's → you must retain a matching card YOURSELF, because you are buying
      // into a house you have no claim on yet. Pagat states this condition for an opponent's house
      // specifically, and it is what stops a player feeding a house they can never collect.
      if (!owningSidesTolerant(state, houseAtValue).has(sideOrSelf(state, actingPlayerId)) && !selfRetains) {
        continue;
      }

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
          keySatisfiedBy: 'self',
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
      //   A player may add to a cemented house only if their SIDE retains at least one card
      //   matching that house's capture value. The retained card may be a teammate's. This applies
      //   whether the played card reaches the value by itself or by combining with floor cards.
      //
      // You cannot reinforce a pukka house your side has no way to eventually collect. The game
      // does not care who OWNS the house — it cares whether your side has a legitimate path to it.
      //
      // REVISED 2026-10-07. The check used to apply only when the played card ALONE matched the
      // house value (needed === 0), on the reasoning that a card reaching the value through a floor
      // combo never had a competing Capture option, so Capture could not be said to take priority.
      // That reasoning is sound, and it answers a different question. Reported twice from live
      // 4-player play: with no 13 in either hand on the side, Add-to-Fixed was offered onto an
      // OPPONENT'S cemented 13-house — 6♣ + 7♠ = 13 — moving a 7-point spade into a house that side
      // could never capture, never break, and held no stake in. The retains concern is the same in
      // both cases; only one of them was being enforced. See ADD_TO_FIXED_OWNERSHIP.md.
      //
      // Hand only, never the 2-player reserve — the same standing the key holds everywhere else.
      // The same test Cement uses, and for the same reason — see above. Red house: bring your own
      // key, and you join the ownership. Blue or purple: your side is already in it.
      const selfRetains = handAfterPlaying.some(c => rankValue(c.rank) === houseValue);
      const ownersBefore = owningSidesTolerant(state, houseAtValue);
      const mySide = sideOrSelf(state, actingPlayerId);
      if (!ownersBefore.has(mySide) && !selfRetains) continue;
      const resultingOwnerSides = [...new Set([...ownersBefore, mySide])].sort();
      for (const absorbed of collectAllCompatibleCombinations(remainingLoose, houseValue)) {
        results.push({
          kind: 'addToFixed',
          handCardId: handCard.id,
          existingHouseId: houseAtValue.id,
          floorCardIds: combo.map(c => c.id),
          resultingValue: houseValue,
          absorbedLooseCardIds: absorbed.map(c => c.id),
          resultingOwnerSides
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
// HOUSE KEY PRESERVATION — frozen by the Product Owner, 2026-09-19, after a seeded 240-round
// diagnostic traced every house left on the floor at round end (27 of them) to one gap: the key
// checks above only ask about the house being made or changed, so a side could spend the LAST key
// of a house it already owned on a different value and strand that house for the rest of the round.
//
// The rule (Pagat's owner/key rule, adapted to Baazi's side ownership): every side that owns a
// house must keep at least one card of that house's capture value in hand until the house is
// captured or broken, and that last key may only be used to capture it — never for a Build,
// Cement, Add-to-Fixed, Break or Merge-Fix. Specifically:
//   - a side is the player in 2-player mode and the team in 4-player mode, so a partner's
//     matching card keeps the team's obligation satisfied;
//   - a jointly owned house binds BOTH sides, each with its own key — the other side's card
//     never counts;
//   - only cards in hand count (a 2-player reserve is not in hand yet), as in every other key
//     check in this file;
//   - once the house is captured or broken it no longer sits at that value, so the obligation
//     ends by itself.
// Capture discovery is untouched: a preserved key always has a capture, because its house is on
// the floor, and the existing mandatory-capture rule already keeps Throw off it.
// ---------------------------------------------------------------------------

/**
 * The sides that own a house. An ordinary house records the individual who built or broke it; a
 * cemented house records side ids (see the Cement branch above) — both resolve to sides here.
 */
function owningSidesOf(state: GameState, house: House): Set<string> {
  return new Set(house.ownerSides.map(owner => (state.players.some(p => p.id === owner) ? sideOf(state, owner) : owner)));
}

/** True when `handCard` is the acting side's last key for a house that side owns. */
function isPreservedHouseKey(state: GameState, actingPlayerId: string, hand: Card[], handCard: Card): boolean {
  const value = rankValue(handCard.rank);
  // Cheapest questions first; sides are only resolved when a house at this value actually exists.
  const housesAtValue = state.floor.houses.filter(h => h.captureValue === value);
  if (housesAtValue.length === 0) return false;
  if (hand.some(c => c.id !== handCard.id && rankValue(c.rank) === value)) return false; // self keeps another

  const side = sideOf(state, actingPlayerId);
  if (!housesAtValue.some(h => owningSidesOf(state, h).has(side))) return false;
  const partnerKeepsOne = teammatesOf(state, actingPlayerId).some(p => p.hand.some(c => rankValue(c.rank) === value));
  return !partnerKeepsOne;
}

// ---------------------------------------------------------------------------
// NORMAL PLAY discovery: house-landing (Build/Cement/Add-to-Fixed) and house-raising
// (Break/MergeFix) actions are always available alongside Capture — Build/Combine is a strategic
// player CHOICE, never mandatory (frozen), so its presence never suppresses Capture or Throw.
// Per the frozen mandatory-capture rule, Throw is only suppressed when a Capture exists.
// The one exception is House Key Preservation (above): a preserved key has no house actions.
// ---------------------------------------------------------------------------

function discoverNormalOptionsForCard(
  state: GameState,
  actingPlayerId: string,
  hand: Card[],
  handCard: Card
): LegalOption[] {
  const houseActions: LegalOption[] = [];
  for (let houseValue = HOUSE_MIN; houseValue <= HOUSE_MAX; houseValue++) {
    houseActions.push(...discoverLandingOptionsForCard(state, actingPlayerId, hand, handCard, houseValue));
  }
  houseActions.push(...discoverRaisingOptionsForCard(state, actingPlayerId, hand, handCard));

  // Only consulted when the card actually has a house action to lose.
  const options: LegalOption[] =
    houseActions.length > 0 && isPreservedHouseKey(state, actingPlayerId, hand, handCard) ? [] : houseActions;

  const captureOptions = discoverCaptureOptionsForValue(state, handCard, rankValue(handCard.rank));
  options.push(...captureOptions);

  if (captureOptions.length === 0) {
    options.push({ kind: 'throw', handCardId: handCard.id });
  }

  return options;
}

// ---------------------------------------------------------------------------
// OPENING discovery, locked to the single announced bid value.
//
// The caller's first play is one of three things, all tied to the value they called: build a house
// of it, play the called card to capture with it, or put the called card down. Build and capture
// are ALTERNATIVES — the caller chooses — and throwing is the fallback when neither is possible.
//
// PRODUCT OWNER CORRECTION, 2026-10-05 (frozen rule changed, deliberately and on the record).
// This used to be a strict Build > Capture > Throw priority: the moment ANY card in hand could
// build the called value, capture became illegal for every card, the called card included. That
// cost a real position in live play — called 13 with Q, A, 7, 6 on the floor and a King in hand,
// where the King takes Q+A and 7+6 together, clears the floor and sweeps for 25. The King was
// offered nothing at all, because some other card in hand could have built a 13. Pagat's own
// description of the first play is the three alternatives above, and it names the first-play sweep
// explicitly, so suppressing the capture was wrong.
//
// What did NOT change: the bid-value lock (only a card of the called value may capture or be
// thrown), throwing as a last resort (a caller who can build or capture may not simply put the
// card down), ordinary-turn capture, and scoring — a first-play sweep is already worth 25 rather
// than 50 (see sweepPoints, and finalizeOpeningAndAdvance which marks it as the opening play).
//
// This remains a whole-hand determination, computed across every card first and then reported per
// card. UNCHANGED by the Combine/Cement architecture: the opening floor never has houses on it, so
// house-awareness is structurally irrelevant here. `resultingOwnerSides` on the Build options it
// produces is overwritten below to the bidder's own id (discoverBuildOptionsForValue's
// placeholder exists purely so its return type matches the shared LegalBuildOption shape).
// ---------------------------------------------------------------------------

function discoverOpeningOptionsForHand(state: GameState, bidderId: string, hand: Card[]): Record<string, LegalOption[]> {
  const bidValue = state.bidValue as number;
  const byCard: Record<string, LegalOption[]> = {};
  for (const card of hand) byCard[card.id] = [];

  // Building a house of the called value, from any card in hand.
  let anyBuild = false;
  for (const card of hand) {
    const builds = discoverBuildOptionsForValue(hand, state.floor.loose, card, bidValue, bidderId);
    if (builds.length) {
      byCard[card.id].push(...builds);
      anyBuild = true;
    }
  }

  // Capturing with the called card itself — offered alongside any build, not behind it.
  let anyCapture = false;
  const bidValueCards = hand.filter(c => rankValue(c.rank) === bidValue);
  for (const card of bidValueCards) {
    const captures = discoverCaptureOptionsForValue(state, card, bidValue);
    if (captures.length) {
      byCard[card.id].push(...captures);
      anyCapture = true;
    }
  }
  if (anyBuild || anyCapture) return byCard;

  // Throwing the called card: the fallback, and only when there is nothing to build or capture.
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
