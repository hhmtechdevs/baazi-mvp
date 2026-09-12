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
