# Defect report: the opening build does not absorb

**Found** 2026-10-06 from live play. **Fixed** 2026-10-07, absorption only, by PO direction.

The lay-alongside divergence in the second-to-last section is **still open** and was deliberately
left unchanged — see that section.

---

## The position

Reported from a Practice round:

- **Hand:** 7, 8, J, K
- **Called:** K (13)
- **Floor:** 8, 5, 6, Q

The player built a 13-house with their 7 and the floor 6. The floor 8 and 5 — already worth 13
together — **stayed loose** instead of being swept into the house.

## The reproduction

The same position, asked of the engine twice:

```
ORDINARY turn:  BUILD 13  with[6♦]  absorb[8♠, 5♣]   ← correct
OPENING play:   BUILD 13  with[6♦]  absorb[]          ← the defect
```

Identical floor, identical hand, two different answers. Normal play obeys the Combine
architecture; the opening does not.

## Root cause

`src/engine/legalMoves.ts`, in `discoverBuildOptionsForValue` — the opening-only build discovery:

```ts
absorbedLooseCardIds: [], // the opening floor has just 4 cards and no pre-existing houses
```

The comment's reasoning is half right:

- **"No pre-existing houses"** — true, and it correctly rules out Cement / Break / MergeFix /
  Add-to-Fixed on the first move of a hand.
- **"...therefore nothing to absorb"** — false. Absorbing *other loose groups already worth the
  called value* has nothing to do with houses. A four-card floor leaves up to three loose cards
  after the build combo is taken, which is ample room for another group at that value.

The module header says this function was "left exactly as before: unchanged" when the Combine
architecture landed. The absorption gap looks like an oversight in that reasoning rather than a
deliberate rule.

Normal play does it correctly in `discoverNormalOptionsForCard`, via
`collectAllCompatibleCombinations(remainingLoose, houseValue)`.

## Why it is not a one-line fix

The opening *action* cannot express absorption. `OpeningAction` (frozen, Ingredient 3) is:

```ts
| { type: 'build'; builderCardId: string; floorCardIds: string[] }
```

There is no field for absorbed cards. And `applyBuild` in `openingAction.ts` constructs the house
as `[...floorCards, builderCard]`, with no concept of absorption and its own independent
validator.

## The fix, in full (four files)

1. **`src/types/index.ts`** — add an optional field to the build variant:
   `absorbedLooseCardIds?: string[]`. Additive and optional, so every existing opening action
   stays valid and no persisted envelope changes shape.
2. **`src/engine/legalMoves.ts`** — in `discoverBuildOptionsForValue`, loop
   `collectAllCompatibleCombinations(remainingLoose, houseValue)` exactly as normal play does, and
   emit one option per absorption alternative.
3. **`src/engine/openingAction.ts`** — `applyBuild` validates the absorbed ids (loose, not already
   in the combo, each group summing to the bid value) and includes them in `house.cards` and in
   the loose-card removal.
4. **`src/engine/moveAdapter.ts`** — `toOpeningAction` carries `absorbedLooseCardIds` through.

**Not affected:** scoring, capture discovery, House Key Preservation, turn progression, dealing,
multiplayer, the envelope version.

## Status of the fix

Implemented as described above, in those four files, plus one stale test helper
(`roundOrchestrator.test.ts`) that had been constructing opening builds by hand and dropping the
absorbed cards — the same omission as the defect itself.

Two decisions taken while implementing, neither specified in the original direction:

1. **Cementing is decided by how many combinations went into the house**, stated explicitly as
   `combinationsInHouse > 1` (the primary combo, plus one per absorbed group) rather than inherited
   from normal play's "did it absorb anything". One combination worth the called value is an
   ordinary house; two or more incorporated into the same house make a fixed one. The two
   conditions select the same houses, but only one of them says what the rule is.
2. **Absorption is mandatory, and enforced.** "Can be incorporated" is read as "must be", so an
   opening build that walks past a group worth the called value is now rejected rather than
   quietly leaving it on the floor. This is what makes the old, defective action impossible to
   send rather than merely unlikely.

## STILL OPEN — a second, separate divergence

Normal play permits a build where the played card is laid down and a group is swept in *alongside*
it (a J with 5+6 beside it becomes a J-house — frozen test 6d). The opening forbids this: it
filters out empty combos outright.

This is the same class of gap and the same root cause, but it is a **larger behaviour change** —
it adds a genuinely new opening option — so it was deliberately NOT resolved during the absorption
fix, by explicit PO direction.

**Current opening behaviour is preserved exactly**, and is now pinned by three tests in
`reportedPositions.test.ts` ("lay-alongside at the opening — unchanged, pending a rules decision"):
normal play offers it, the opening does not, and the opening action refuses one if asked directly.
Those tests exist so that implementing absorption could not change this by accident, and so that
changing it later has to be a deliberate act.

**This remains an open rules decision.** It is not a resolved defect.

## Cost of leaving it

Material. In the reported position the 8 and 5 stay on the floor for the opponent to collect.

## Tests

`src/engine/reportedPositions.test.ts`. The `it.fails` placeholders are gone, converted to ordinary
assertions now that the behaviour is correct. Coverage: the ordinary-turn build, the opening build,
the action carrying the absorbed ids, the full play-out of the reported scenario, rejection of a
build that leaves a group behind, rejection of absorbed cards that are not whole groups, and a
plain uncemented build where there is nothing to absorb.

Full suite 453 passing, typecheck clean, build clean.
