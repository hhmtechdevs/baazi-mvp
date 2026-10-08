import { describe, expect, it } from 'vitest';
import { discoverLegalOptions, discoverLegalOptionsForHand } from './legalMoves';
import { executeMove } from './moveExecution';
import { submitOpeningAction } from './roundOrchestrator';
import { sweepPoints } from './scoring';
import { createDeck } from './deck';
import { planForCard } from '../ui/cardChoices';
import type { Card, GameState, Player } from '../types';

/**
 * REPORTED FROM LIVE PLAY: a King is played with Q, A, 7 and 6 lying loose. Q + A = 13 and 7 + 6 =
 * 13 do not share a card, so under the "collect everything compatible" rule the King must take all
 * four, which empties the floor and sweeps. The report was that no such option appeared.
 *
 * These tests pin the exact position in both places it can arise — an ordinary turn and the opening
 * play — because the two are governed by different frozen rules and only one of them can produce
 * the behaviour that was described.
 */

const card = (rank: Card['rank'], suit: Card['suit']): Card => ({ id: `${rank}-${suit}`, rank, suit });
const player = (id: string, hand: Card[]): Player => ({ id, name: id, teamId: null, hand, reserve: [], captured: [] });

/** The floor from the report: Q, A, 7, 6, all loose. */
const theFloor = () => [card('Q', 'clubs'), card('A', 'diamonds'), card('7', 'hearts'), card('6', 'spades')];

function midRound(hand: Card[], looseOverride?: Card[]): GameState {
  const loose = looseOverride ?? theFloor();
  const opponent = [card('2', 'hearts')];
  const used = new Set([...hand, ...loose, ...opponent].map(c => c.id));
  return {
    gameId: 'g', mode: '2player', roundNumber: 1,
    players: [player('p1', hand), player('p2', opponent)],
    teams: [], floor: { loose, houses: [] },
    deck: createDeck().filter(c => !used.has(c.id)),
    phase: 'playing', currentPlayerIndex: 0, turnNumber: 6,
    bidValue: null, bidderId: null, sweepRecords: [], scores: {}, roundScores: {}, history: []
  };
}

function atTheOpening(hand: Card[], bidValue = 13): GameState {
  return { ...midRound(hand), phase: 'revealing', bidderId: 'p1', bidValue, turnNumber: 0 };
}

describe('a King over Q + A and 7 + 6', () => {
  it('takes all four cards in one capture, and that capture sweeps the floor', () => {
    const king = card('K', 'spades');
    const state = midRound([king, card('3', 'clubs')]);

    const captures = discoverLegalOptions(state, 'p1', king.id).filter(o => o.kind === 'capture');
    expect(captures).toHaveLength(1);

    const taken = captures[0].targets.map(t => (t.type === 'loose' ? t.cardId : t.houseId)).sort();
    expect(taken).toEqual(['7-hearts', 'A-diamonds', 'Q-clubs', '6-spades'].sort());
    expect(captures[0].isSeep).toBe(true);
  });

  it('is the ONLY thing that King may do — mandatory capture leaves no throw', () => {
    const king = card('K', 'spades');
    const kinds = discoverLegalOptions(midRound([king, card('3', 'clubs')]), 'p1', king.id).map(o => o.kind);
    expect(kinds).toEqual(['capture']);
  });

  it('actually clears the floor and records the sweep when executed', () => {
    const king = card('K', 'spades');
    const state = midRound([king, card('3', 'clubs')]);
    const capture = discoverLegalOptions(state, 'p1', king.id).find(o => o.kind === 'capture')!;

    const after = executeMove(state, 'p1', { kind: 'capture', handCardId: king.id, targets: capture.targets });
    expect(after.floor.loose).toHaveLength(0);
    expect(after.floor.houses).toHaveLength(0);
    expect(after.players.find(p => p.id === 'p1')!.captured.map(c => c.id).sort()).toEqual(
      ['7-hearts', 'A-diamonds', 'K-spades', 'Q-clubs', '6-spades'].sort()
    );
    expect(after.sweepRecords).toHaveLength(1);
  });

  it('reaches the player as a single tap, flagged as sweeping the floor', () => {
    const king = card('K', 'spades');
    const state = midRound([king, card('3', 'clubs')]);
    const plan = planForCard(discoverLegalOptions(state, 'p1', king.id), state);

    // One legal option means the tap plays it — there is no row of choices to read, which is very
    // probably what "the option was not offered" looked like from the table.
    expect(plan.kind).toBe('direct');
    if (plan.kind !== 'direct') throw new Error('expected a direct play');
    expect(plan.choice.verb).toBe('COLLECT');
    expect(plan.choice.sweeps).toBe(true);
  });
});

/**
 * THE REPORTED POSITION, at the opening — the one this whole investigation came from.
 *
 * Called 13, floor Q A 7 6, hand holds the King. Until 2026-10-05 the opening ran a strict
 * Build > Capture > Throw priority, so the moment any card in hand could build a 13 the King was
 * offered nothing at all — and a four-card capture that clears the floor and sweeps was simply
 * unreachable. Product Owner correction: build and capture are alternatives the caller chooses
 * between, and only throwing waits behind them.
 */
describe('the same King at the OPENING', () => {
  it('is offered its capture even though other cards in hand can build the called value', () => {
    // The hand from the report: K, Q, A, 10. The Q builds 13 with the loose A, the A with the Q —
    // none of which may take the King's capture away.
    const king = card('K', 'spades');
    const state = atTheOpening([king, card('Q', 'hearts'), card('A', 'spades'), card('10', 'clubs')]);
    const byCard = discoverLegalOptionsForHand(state, 'p1');

    const captures = byCard[king.id].filter(o => o.kind === 'capture');
    expect(captures).toHaveLength(1);
    expect(captures[0].targets.map(t => (t.type === 'loose' ? t.cardId : t.houseId)).sort()).toEqual(
      ['7-hearts', 'A-diamonds', 'Q-clubs', '6-spades'].sort()
    );
    expect(captures[0].isSeep).toBe(true);

    // And the builds are still there: the caller chooses, rather than being told.
    expect(Object.values(byCard).flat().some(o => o.kind === 'build')).toBe(true);
  });

  it('clears the floor and scores the first-play sweep at a full 50', () => {
    const king = card('K', 'spades');
    const state = atTheOpening([king, card('Q', 'hearts'), card('A', 'spades'), card('10', 'clubs')]);
    const capture = discoverLegalOptionsForHand(state, 'p1')[king.id].find(o => o.kind === 'capture')!;

    const game = { state, dealerId: 'p2', gameLengthConfig: { type: 'fixedRounds' as const, rounds: 1 } };
    const after = submitOpeningAction(game, 'p1', {
      type: 'capture',
      bidCardId: king.id,
      targets: capture.targets
    }).state;

    expect(after.floor.loose).toHaveLength(0);
    expect(after.sweepRecords).toHaveLength(1);
    expect(after.sweepRecords[0].isOpeningPlay).toBe(true);
    expect(sweepPoints(after.sweepRecords[0])).toBe(50);
  });

  it('still refuses to let the caller simply throw the called card while a capture is there', () => {
    const king = card('K', 'spades');
    const state = atTheOpening([king, card('Q', 'hearts'), card('A', 'spades'), card('10', 'clubs')]);
    expect(discoverLegalOptionsForHand(state, 'p1')[king.id].some(o => o.kind === 'throw')).toBe(false);
  });

  it('offers the four-card capture when no build at 13 exists either', () => {
    const king = card('K', 'spades');
    const state = atTheOpening([king, card('4', 'clubs')]);
    const captures = discoverLegalOptionsForHand(state, 'p1')[king.id].filter(o => o.kind === 'capture');

    expect(captures).toHaveLength(1);
    expect(captures[0].targets).toHaveLength(4);
    expect(captures[0].isSeep).toBe(true);
  });

  it('falls back to throwing the called card only when nothing can be built or taken', () => {
    // A bare floor: nothing to capture, nothing to build with.
    const king = card('K', 'spades');
    const bare: GameState = { ...atTheOpening([king, card('4', 'clubs')]), floor: { loose: [], houses: [] } };
    expect(discoverLegalOptionsForHand(bare, 'p1')[king.id].map(o => o.kind)).toEqual(['throw']);
  });
});

/**
 * THE SAME CAPTURE, OFFERED TWICE — found in seeded play at roughly one option list in 120,000,
 * and long visible as an intermittent failure of the bot's "every chosen move was discovered"
 * invariant. Fixed 2026-10-07.
 *
 * The search finds every MAXIMAL SET OF GROUPS, and two different groupings can cover exactly the
 * same cards. A 3 played over 2♦ A♠ 2♠ A♥ can pair 2♦+A♠ with 2♠+A♥, or 2♦+A♥ with 2♠+A♠ — the
 * same four cards either way. The grouping is an artefact of the search; what the player chooses
 * between is the set of cards they pick up.
 */
describe('a capture is offered once per set of cards taken, not once per grouping', () => {
  const threeOverTwoPairs = () =>
    midRound([card('3', 'hearts'), card('9', 'clubs')], [
      card('2', 'diamonds'),
      card('6', 'diamonds'),
      card('A', 'spades'),
      card('A', 'hearts'),
      card('2', 'spades')
    ]);

  it('offers exactly one capture where two groupings reach the same four cards', () => {
    const captures = discoverLegalOptions(threeOverTwoPairs(), 'p1', '3-hearts').filter(o => o.kind === 'capture');

    expect(captures).toHaveLength(1);
    expect(captures[0].targets.map(t => (t.type === 'loose' ? t.cardId : t.houseId)).sort()).toEqual(
      ['2-diamonds', '2-spades', 'A-hearts', 'A-spades'].sort()
    );
  });

  it('shows the player one COLLECT, not two identical ones', () => {
    // There IS a real choice here — the 3 can also build a 9-house with the loose 6, keeping the
    // 9 in hand — so the row is expected. What must not appear is the same collect listed twice.
    const state = threeOverTwoPairs();
    const plan = planForCard(discoverLegalOptions(state, 'p1', '3-hearts'), state);

    if (plan.kind !== 'choose') throw new Error('expected a row of choices');
    expect(plan.choices.filter(c => c.verb === 'COLLECT')).toHaveLength(1);
    expect(plan.choices.map(c => c.verb)).toContain('BUILD HOUSE');

    // And no two choices describe the same move.
    const details = plan.choices.map(c => `${c.verb} ${c.detail}`);
    expect(new Set(details).size).toBe(details.length);
  });

  it('never offers two options with the same targets, across every card of a cluttered floor', () => {
    // A floor dense in low cards is where equivalent groupings multiply.
    const floor = [card('A', 'spades'), card('A', 'hearts'), card('2', 'spades'), card('2', 'diamonds'), card('3', 'clubs')];
    for (const rank of ['2', '3', '4', '5', '6'] as const) {
      const state = midRound([card(rank, 'hearts'), card('9', 'clubs')], floor);
      const captures = discoverLegalOptions(state, 'p1', `${rank}-hearts`).filter(o => o.kind === 'capture');
      const keys = captures.map(c => c.targets.map(t => (t.type === 'loose' ? t.cardId : t.houseId)).sort().join('+'));

      expect(new Set(keys).size, `duplicate capture offered for a ${rank}`).toBe(keys.length);
    }
  });
});
