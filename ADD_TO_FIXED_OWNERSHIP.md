# Defect report: Add-to-Fixed onto an opponent's house you cannot capture

**Found** 2026-10-07 in live Family play (table CC3X, round 1) — **twice in one round**.
**Status:** **FIXED** 2026-10-07 by Product Owner decision. The rule now reads:

> A player may add to a cemented house only if their side retains at least one card matching that
> house's capture value. The retained matching card may belong to either teammate in 4-player play.
> This requirement applies whether the played card reaches the house value by itself or by
> combining with floor cards.

Deliberately **not** expressed as a prohibition on opponents' houses. The game does not care who
owns the house, only whether the acting side has a legitimate path to collecting it — one rule, no
special-case strategy logic.

---

## What happens

You are offered **ADD TO HOUSE** onto an **opponent's cemented house** whose capture value nobody
on your side holds. Taking it hands your card *and* floor cards into a house that:

- you do not own and never will — Add-to-Fixed leaves `ownerSides` untouched
- cannot be broken — it is cemented
- you can never capture — your side holds no card of that value

It is a move with a cost and no upside of any kind.

## Evidence — two positions from one round

### Turn 31

Hand **4♣ 9♣ 9♥ 6♣ 10♣** (no 13). Floor loose **2♠ 4♦ 3♠**.
House `house-3da8…`, value **13**, `ownerSides: ["right"]`, `isCemented: true`, holding 5♦ K♦ 8♦.

Four separate ways in were offered:

| Card | plus floor | = |
|---|---|---|
| 4♣ | 2♠ + 4♦ + 3♠ | 13 |
| 9♣ | 4♦ | 13 |
| 9♥ | 4♦ | 13 |
| 6♣ | 4♦ + 3♠ | 13 |

### Turn 39 — the clearer one

Hand **9♣ 6♣ 10♣**. Partner's hand **5♠ 6♠**. **Neither holds a 13.**
Floor loose **7♠ A♠**. Same opponent 13-house, still cemented.

Offered: `6♣ + 7♠ = 13` into that house.

**7♠ alone is worth 7 points**, and `right` was holding **K♠** at that moment — able to collect the
house, and the gift, on their very next turn.

## Root cause

`src/engine/legalMoves.ts`, in the Add-to-Fixed branch:

```ts
const retainsAnother = handAfterPlaying.some(c => rankValue(c.rank) === houseValue);
if (needed === 0 && !retainsAnother) continue;
```

The retains-check fires **only when the played card alone matches the house value**. Every offer
above reaches 13 *through floor cards*, so `needed > 0` and no check applies at all.

The comment above that line explains the exemption, and its reasoning is sound — but it answers a
**different question**. It is about mandatory capture: a card that only reaches the value via a
combo never had a competing capture option, so capture cannot be said to take priority. The
question it never asks is whether you should be able to feed a house your side can never collect.

## The asymmetry

| | Ownership after | Key required |
|---|---|---|
| **Cement** (house not yet cemented) | becomes **joint** | yes — self or partner |
| **Add-to-Fixed** (house already cemented) | **unchanged** | only when `needed === 0` |

Adding to an opponent's *cemented* house is the single path that grants no stake and demands no
key. Cementing an opponent's house — the weaker move strategically — is held to the stricter rule.

## The fix as implemented

`legalMoves.ts`, Add-to-Fixed branch:

```ts
const selfRetains = handAfterPlaying.some(c => rankValue(c.rank) === houseValue);
const sideRetains =
  selfRetains ||
  knownTeammatesOf(state, actingPlayerId).some(p => p.hand.some(c => rankValue(c.rank) === houseValue));
if (!sideRetains) continue;
```

The `needed === 0` condition is gone: the check now applies however the value is reached. Own hand
is consulted first and the partner only if that fails, because resolving a side throws on a
4-player state whose teams are not yet populated, and `knownTeammatesOf` answers "nobody" in that
case rather than taking the table down — which can only ever withhold a move, never permit one.

Ownership and cementing remain untouched by Add-to-Fixed, exactly as before.

## The decision, as taken

1. Should Add-to-Fixed require that the acting player's **side** retains a card worth the house
   value, whether the played card reaches it alone or through floor cards?
2. Should adding to an **opponent's** house be possible at all when it confers no stake in it?

A yes to (1) refuses every offer above. My reading is that it follows directly from the reason the
existing rule already gives — *you cannot add to a pukka house you have no matching card to
eventually collect* — which the code currently enforces in only one of the two ways it can arise.

## Files

- `src/engine/legalMoves.ts` — the Add-to-Fixed branch of `discoverNormalOptionsForCard`
- `src/engine/moveExecution.ts` — `executeAddToFixed` ("ownerSides are deliberately untouched")

## Tests

`src/engine/addToFixedOwnership.test.ts` pins the turn-39 position: the offer exists, nobody on the
acting side holds a 13, execution moves both cards into the opponent's house while leaving
ownership and cementing untouched, and — for contrast — the one case the current rule *does* refuse
(a lone 13 reinforcing without a second 13 held back).

These assert **current** behaviour. If the rule changes they will fail, which is the point: this
cannot be altered silently.

## Not related to

The opening-build absorption fix (`OPENING_BUILD_ABSORPTION.md`). Different rule, different code
path. The lay-alongside divergence recorded there remains separately open.
