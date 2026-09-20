import { describe, expect, it } from 'vitest';
import {
  completeRound,
  isRoundComplete,
  startNextRound,
  startRound,
  submitBid,
  submitMove,
  submitOpeningAction
} from '../engine/roundOrchestrator';
import { chooseBid, chooseMove, chooseOpeningAction } from '../botStrategy';
import { dealNextRound, nextHostStep, startTable } from '../multiplayer/host';
import { HUMAN_TURN_MS, createEnvelope } from '../multiplayer/protocol';
import type { TableEnvelope } from '../multiplayer/protocol';
import { matchTally, sidesInPlay } from './table';

/**
 * The Family table, played out with the timers taken away.
 *
 * useBaaziGame seats four players and then drives every seat that isn't yours through exactly
 * these calls — the same orchestrator and the same strategy module the two-handed table uses,
 * never a second implementation. That is the claim this file checks: that the four-handed seating
 * it hands the engine really does deal, play and score a whole game, rather than only looking
 * right for the first few turns.
 *
 * Kept in ui/ deliberately: the engine's own four-player behaviour is covered by the engine's
 * tests. What's new here, and what could break, is the seat configuration this pass introduced.
 */
describe('the Family table can be played to the end', () => {
  const seats = [
    { id: 'you', name: 'You' },
    { id: 'left', name: 'Left' },
    { id: 'partner', name: 'Partner' },
    { id: 'right', name: 'Right' }
  ];

  function freshGame() {
    return startRound({
      gameId: 'family-table-test',
      mode: '4player',
      players: seats,
      dealerId: 'you',
      gameLengthConfig: { type: 'leadTarget', points: 100 }
    });
  }

  it('runs a four-handed 100-point game to completion, scoring by team throughout', () => {
    let game = freshGame();

    for (let round = 1; round <= 40; round++) {
      const bidder = game.state.bidderId!;
      game = submitBid(game, bidder, chooseBid(game, bidder).choice);
      game = submitOpeningAction(game, bidder, chooseOpeningAction(game, bidder).choice);

      // The bidder has played their opening card; everyone else is holding a full twelve.
      expect(game.state.players.map(p => p.hand.length).sort()).toEqual([11, 12, 12, 12]);

      let moves = 0;
      while (!isRoundComplete(game)) {
        if (++moves > 500) throw new Error(`round ${round} never finished`);
        const current = game.state.players[game.state.currentPlayerIndex].id;
        game = submitMove(game, current, chooseMove(game, current).choice);
      }

      const result = completeRound(game);
      // Four-handed play scores by SIDE, and a side is a team — which is what the table's score
      // line and its running tally both read.
      expect(Object.keys(result.state.scores).sort()).toEqual(['team-0', 'team-1']);
      expect(Object.keys(result.breakdown).sort()).toEqual(['team-0', 'team-1']);

      if (result.gameOver) return;
      game = startNextRound(game, result);
    }
    throw new Error('the game never reached a 100-point lead');
  });

  it('partners you with the player opposite, not with a neighbour', () => {
    let game = freshGame();
    const bidder = game.state.bidderId!;
    game = submitBid(game, bidder, chooseBid(game, bidder).choice);
    game = submitOpeningAction(game, bidder, chooseOpeningAction(game, bidder).choice);

    const yourTeam = game.state.teams.find(t => t.playerIds.includes('you'))!;
    expect(yourTeam.playerIds).toContain('partner');
    expect(yourTeam.playerIds).not.toContain('left');
    expect(yourTeam.playerIds).not.toContain('right');
  });
});

/**
 * The tally that sits at the top of a Family table, end to end: the authority scores a round, the
 * two numbers go onto the table itself, the next round is dealt — and the tally still reads them.
 *
 * This is the join the unit tests either side of it cannot see: host.ts writes `lastRoundScores`,
 * table.ts's matchTally turns it into the line people read, and the round in between wipes
 * everything else about the round that just finished.
 */
describe('the tally at the top of a Family table', () => {
  function seatedTable(): TableEnvelope {
    const withHost = createEnvelope('TALY', 'host-session', 'You');
    return startTable(withHost, 'you');
  }

  /** Run the authority until the round has been played and scored. */
  function scoredRound(envelope: TableEnvelope): TableEnvelope {
    let table = envelope;
    let now = Date.now();
    for (let i = 0; i < 4000 && !table.lastResult; i++) {
      now += HUMAN_TURN_MS + 1_000; // past every allowance, so the authority plays each seat
      const step = nextHostStep(table, now);
      if (step) table = step.envelope;
    }
    if (!table.lastResult) throw new Error('the round never finished');
    return table;
  }

  it('says who leads and what the last round was worth, and keeps saying it through the next deal', () => {
    const scored = seatedTable();
    const table = scoredRound(scored);
    const sides = sidesInPlay(table.game!.state, 'you');
    expect(sides).toHaveLength(2); // a match is always two sides

    const totals = Object.fromEntries(Object.entries(table.lastResult!.breakdown).map(([s, b]) => [s, b.total]));
    const afterScoring = matchTally(table.game!.state, sides, 'you', table.lastRoundScores);
    expect(afterScoring.lastRound).toBe(`Last round ${sides.map(s => totals[s]).join(' – ')}`);
    expect(afterScoring.lead).toMatch(/^(Level|.+ leads? by \d+)$/);

    if (table.lastResult!.gameOver) return; // a 100-point lead in one round; there is no next deal

    // The score card goes; the tally does not.
    const next = dealNextRound(table);
    expect(next.lastResult).toBeNull();
    const afterDealing = matchTally(next.game!.state, sidesInPlay(next.game!.state, 'you'), 'you', next.lastRoundScores);
    expect(afterDealing).toEqual(afterScoring);
  });

  it('has nothing to say in round 1, before anything has been scored', () => {
    const table = seatedTable();
    const state = table.game!.state;
    expect(matchTally(state, sidesInPlay(state, 'you'), 'you', table.lastRoundScores)).toEqual({
      lead: null,
      lastRound: null
    });
  });
});
