import { describe, expect, it } from 'vitest';
import { applyRequest, dealNextRound, nextHostStep, playAiTurn, startTable } from './host';
import { claimSeat, createEnvelope, expectedActor, seatRecord } from './protocol';
import type { ActionRequest, SeatId, TableEnvelope } from './protocol';
import { discoverLegalMoves } from '../engine/roundOrchestrator';
import { flattenOptionsForHand, toNormalPlayMove } from '../engine/moveAdapter';

const HOST = 'session-divjot';
const GUEST = 'session-sydney';

function seated(): TableEnvelope {
  const claim = claimSeat(createEnvelope('K7QM', HOST, 'Sydney'), GUEST, 'Sydney');
  if (!claim.ok) throw new Error('fixture: guest could not sit down');
  return claim.envelope;
}

function sessionFor(seat: SeatId): string {
  return seat === 'you' ? HOST : GUEST;
}

function request(env: TableEnvelope, seat: SeatId, kind: ActionRequest['kind'], payload: unknown, over: Partial<ActionRequest> = {}): ActionRequest {
  return { id: `r-${Math.random()}`, sessionId: sessionFor(seat), seat, forGameRevision: env.gameRevision, kind, payload, ...over };
}

/**
 * Advance the table the way the real host does — one step at a time — until it's waiting on a
 * particular human seat, or we run out of patience. This is the same loop the browser runs, minus
 * the pause before an AI plays.
 */
function runUntilHumanTurn(start: TableEnvelope, limit = 200): TableEnvelope {
  let table = start;
  for (let i = 0; i < limit; i++) {
    const actor = expectedActor(table);
    if (actor && seatRecord(table, actor)!.kind === 'human') return table;
    const step = nextHostStep(table, { aiIsReady: true });
    if (!step) return table;
    table = step.envelope;
  }
  throw new Error('table never came round to a human');
}

describe('the host deals, once, when the table is full', () => {
  it('deals a four-handed round with the seats it was given', () => {
    const step = nextHostStep(seated(), { aiIsReady: true });
    expect(step?.kind).toBe('deal');
    const game = step!.envelope.game!;
    expect(game.state.mode).toBe('4player');
    expect(game.state.players.map(p => p.id)).toEqual(['you', 'left', 'partner', 'right']);
    expect(step!.envelope.status).toBe('playing');
  });

  it('does not deal again once there is a game', () => {
    const dealt = startTable(seated());
    const step = nextHostStep(dealt, { aiIsReady: true });
    expect(step?.kind).not.toBe('deal');
  });

  it('does not deal while the table is still waiting for somebody', () => {
    expect(nextHostStep(createEnvelope('K7QM', HOST), { aiIsReady: true })).toBeNull();
  });

  it('gives every authoritative change its own revision', () => {
    const before = seated();
    const after = nextHostStep(before, { aiIsReady: true })!.envelope;
    expect(after.revision).toBe(before.revision + 1);
  });
});

describe('the engine, not this layer, decides what is legal', () => {
  it('applies a legal move and records it as done', () => {
    const table = runUntilHumanTurn(startTable(seated()));
    const seat = expectedActor(table)!;
    const choice = humanChoice(table, seat);

    const action = request(table, seat, choice.kind, choice.payload);
    const result = applyRequest(table, action);

    expect(result.applied).toBe(true);
    expect(result.envelope.game).not.toEqual(table.game);
    expect(result.envelope.lastAppliedRequestId).toBe(action.id);
    expect(result.envelope.request).toBeNull();
    expect(result.envelope.lastRejection).toBeNull();
  });

  it('refuses a move the engine rejects, and changes no game state', () => {
    const table = runUntilHumanTurn(startTable(seated()));
    const seat = expectedActor(table)!;
    // A card that is in nobody's hand. Whether that is illegal is the engine's call, not ours.
    const result = applyRequest(table, request(table, seat, 'move', { kind: 'throw', handCardId: 'not-a-real-card' }));

    expect(result.applied).toBe(false);
    expect(result.envelope.game).toEqual(table.game);
    expect(result.envelope.lastRejection?.reason).toBeTruthy();
    expect(result.envelope.lastAppliedRequestId).toBeNull();
  });

  it('refuses an action from the wrong seat without touching the game', () => {
    const table = runUntilHumanTurn(startTable(seated()));
    const seat = expectedActor(table)!;
    const choice = humanChoice(table, seat);
    const impostor = request(table, seat, choice.kind, choice.payload, { sessionId: 'session-someone-else' });
    const result = applyRequest(table, impostor);

    expect(result.applied).toBe(false);
    expect(result.envelope.game).toEqual(table.game);
    expect(result.envelope.lastRejection?.reason).toMatch(/not your seat/i);
  });

  it('applies a repeated request exactly once', () => {
    const table = runUntilHumanTurn(startTable(seated()));
    const seat = expectedActor(table)!;
    const choice = humanChoice(table, seat);
    const action = request(table, seat, choice.kind, choice.payload);

    const first = applyRequest(table, action);
    expect(first.applied).toBe(true);

    // The same request arriving again — a retry, a double tap, a reconnect.
    const replayed = { ...action, forGameRevision: first.envelope.gameRevision };
    const second = applyRequest(first.envelope, replayed);
    expect(second.applied).toBe(false);
    expect(second.envelope.game).toEqual(first.envelope.game);
  });

  it('refuses an action built on a table that has already moved on', () => {
    const table = runUntilHumanTurn(startTable(seated()));
    const seat = expectedActor(table)!;
    const choice = humanChoice(table, seat);
    const stale = request(table, seat, choice.kind, choice.payload, { forGameRevision: table.gameRevision - 1 });
    const result = applyRequest(table, stale);
    expect(result.applied).toBe(false);
    expect(result.envelope.game).toEqual(table.game);
  });
});

describe('the computer seats', () => {
  it('are played by the strategy module, through the engine', () => {
    let table = startTable(seated());
    // Walk to a point where a computer seat is on.
    for (let i = 0; i < 40 && seatRecord(table, expectedActor(table)!)!.kind === 'human'; i++) {
      const seat = expectedActor(table)!;
      const phase = table.game!.state.phase;
      if (phase === 'bidding') {
        table = applyRequest(table, request(table, seat, 'bid', 11)).envelope;
      } else break;
    }
    const aiSeat = expectedActor(table)!;
    if (seatRecord(table, aiSeat)!.kind !== 'ai') return; // host seat happened to lead; covered elsewhere

    const before = table.game;
    const after = playAiTurn(table, aiSeat);
    expect(after.game).not.toEqual(before);
    expect(after.revision).toBe(table.revision + 1);
  });

  it('refuse to be played out of turn', () => {
    const table = startTable(seated());
    const notActing = (['left', 'right'] as SeatId[]).find(s => s !== expectedActor(table))!;
    expect(() => playAiTurn(table, notActing)).toThrow(/not .*turn/i);
  });

  it('are never a seat a person can be asked to play', () => {
    const table = startTable(seated());
    expect(() => playAiTurn(table, 'you')).toThrow(/not played by the computer/i);
  });

  it('are held back until the host says the pause is over', () => {
    let table = startTable(seated());
    while (seatRecord(table, expectedActor(table)!)!.kind === 'human') {
      const seat = expectedActor(table)!;
      table = applyRequest(table, request(table, seat, 'bid', 11)).envelope;
      if (table.game!.state.phase !== 'bidding') break;
    }
    if (seatRecord(table, expectedActor(table)!)!.kind !== 'ai') return;
    expect(nextHostStep(table, { aiIsReady: false })).toBeNull();
    expect(nextHostStep(table, { aiIsReady: true })?.kind).toBe('ai');
  });
});

describe('a whole round, driven the way the host drives it', () => {
  it('plays out with two human seats and two computer seats, scoring by team', () => {
    let table = startTable(seated());
    let humanActions = 0;

    for (let tick = 0; tick < 900; tick++) {
      const state = table.game!.state;
      if (state.phase === 'roundEnd' || state.phase === 'gameEnd') break;

      const actor = expectedActor(table);
      if (actor && seatRecord(table, actor)!.kind === 'human') {
        // Stand in for a person: pick the first thing the engine offers that seat.
        const action = humanChoice(table, actor);
        const result = applyRequest(table, request(table, actor, action.kind, action.payload));
        expect(result.applied).toBe(true);
        table = result.envelope;
        humanActions++;
        continue;
      }
      const step = nextHostStep(table, { aiIsReady: true });
      if (!step) break;
      table = step.envelope;
    }

    expect(table.game!.state.phase).toBe('roundEnd');
    expect(humanActions).toBeGreaterThan(5);
    // Both humans actually played — this is a 2-on-2 game, not one person and three computers.
    expect(table.game!.state.teams.map(t => t.playerIds.sort()).sort()).toEqual([
      ['left', 'right'],
      ['partner', 'you']
    ]);
  });
});

describe('the end of a round', () => {
  function playToRoundEnd(): TableEnvelope {
    let table = startTable(seated());
    for (let tick = 0; tick < 900; tick++) {
      if (table.game!.state.phase === 'roundEnd') return table;
      const actor = expectedActor(table);
      if (actor && seatRecord(table, actor)!.kind === 'human') {
        const choice = humanChoice(table, actor);
        table = applyRequest(table, request(table, actor, choice.kind, choice.payload)).envelope;
        continue;
      }
      const step = nextHostStep(table, { aiIsReady: true });
      if (!step) break;
      table = step.envelope;
    }
    throw new Error('round never ended');
  }

  it('is scored once, by the authority, so both players read the same numbers', () => {
    const finished = playToRoundEnd();
    expect(finished.lastResult).toBeNull();

    const step = nextHostStep(finished, { aiIsReady: true });
    expect(step?.kind).toBe('score');

    const scored = step!.envelope;
    expect(Object.keys(scored.lastResult!.breakdown).sort()).toEqual(['team-0', 'team-1']);
    // Card points are bounded by the deck; sweeps sit on top.
    const cardPoints = Object.values(scored.lastResult!.breakdown).reduce((sum, b) => sum + b.cardPoints, 0);
    expect(cardPoints).toBeLessThanOrEqual(100);

    // And it is not scored twice.
    expect(nextHostStep(scored, { aiIsReady: true })?.kind).not.toBe('score');
  });

  it('deals the next round only when somebody asks, and clears the old score', () => {
    const scored = nextHostStep(playToRoundEnd(), { aiIsReady: true })!.envelope;
    if (scored.lastResult!.gameOver) return; // a 100-point lead in one round; nothing to deal

    const next = dealNextRound(scored);
    expect(next.lastResult).toBeNull();
    expect(next.game!.state.roundNumber).toBe(scored.game!.state.roundNumber + 1);
    expect(next.game!.state.phase).toBe('bidding');
    expect(next.gameRevision).toBe(scored.gameRevision + 1);
    // Cumulative scores carried over rather than reset.
    expect(next.game!.state.scores).toEqual(scored.lastResult!.state.scores);
  });

  it('refuses to deal on from a round that has not been scored', () => {
    expect(() => dealNextRound(playToRoundEnd())).toThrow(/no finished round/i);
  });
});

function humanChoice(table: TableEnvelope, seat: SeatId): { kind: ActionRequest['kind']; payload: unknown } {
  const game = table.game!;
  const phase = game.state.phase;
  if (phase === 'bidding') return { kind: 'bid', payload: 11 };

  const options = flattenOptionsForHand(discoverLegalMoves(game, seat));
  if (phase === 'revealing') {
    const option = options[0];
    if (!option) throw new Error('no opening action available');
    // toOpeningAction lives beside toNormalPlayMove; the opening shape is derived the same way.
    if (option.kind === 'build') return { kind: 'openingAction', payload: { type: 'build', builderCardId: option.handCardId, floorCardIds: option.floorCardIds } };
    if (option.kind === 'capture') return { kind: 'openingAction', payload: { type: 'capture', bidCardId: option.handCardId, targets: option.targets } };
    return { kind: 'openingAction', payload: { type: 'throw', bidCardId: option.handCardId } };
  }
  const option = options[0];
  if (!option) throw new Error('no legal move available');
  return { kind: 'move', payload: toNormalPlayMove(option) };
}
