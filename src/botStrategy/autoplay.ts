import type { GameLengthConfig, OrchestratedGame, RoundCompletionResult } from '../engine/roundOrchestrator';
import { completeRound, isRoundComplete, startNextRound, startRound, submitBid, submitMove, submitOpeningAction } from '../engine/roundOrchestrator';
import { chooseBid, chooseMove, chooseOpeningAction } from './strategy';

// ---------------------------------------------------------------------------
// Full-game auto-play (Section 16) — both sides are strategic bots, driven entirely through the
// same discoverLegalMoves -> choose -> submit pathway a human or the single-bot UI flow uses.
// This exists to exercise the whole engine/bot seam repeatedly and automatically, not to
// introduce a second rules implementation — every state transition here is produced by the real
// orchestrator functions.
// ---------------------------------------------------------------------------

export interface AutoPlayResult {
  finalGame: OrchestratedGame;
  finalResult: RoundCompletionResult;
  events: string[];
  roundsPlayed: number;
}

export function playAutomatedGame(params: {
  playerAId: string;
  playerBId: string;
  dealerId: string;
  gameLengthConfig: GameLengthConfig;
  maxMovesPerRound?: number;
  maxRounds?: number;
  onEvent?: (event: string) => void;
}): AutoPlayResult {
  const maxMovesPerRound = params.maxMovesPerRound ?? 500;
  const maxRounds = params.maxRounds ?? 100; // a purely defensive cap against a genuine non-termination bug, independent of gameLengthConfig
  const events: string[] = [];
  const log = (event: string): void => {
    events.push(event);
    params.onEvent?.(event);
  };

  let game = startRound({
    gameId: `autoplay-${Date.now()}`,
    mode: '2player',
    players: [{ id: params.playerAId, name: params.playerAId }, { id: params.playerBId, name: params.playerBId }],
    dealerId: params.dealerId,
    gameLengthConfig: params.gameLengthConfig
  });
  log(`Round ${game.state.roundNumber} dealt. Bidder: ${game.state.bidderId}.`);

  let roundsPlayed = 0;
  let result: RoundCompletionResult;

  for (;;) {
    roundsPlayed++;
    if (roundsPlayed > maxRounds) {
      throw new Error(`Automated game exceeded ${maxRounds} rounds without reaching game completion — likely a non-termination bug.`);
    }

    const bidderId = game.state.bidderId!;
    const bidValue = chooseBid(game, bidderId).choice;
    game = submitBid(game, bidderId, bidValue);
    log(`${bidderId} bid ${bidValue}.`);

    const openingAction = chooseOpeningAction(game, bidderId).choice;
    game = submitOpeningAction(game, bidderId, openingAction);
    log(`${bidderId} opened with ${openingAction.type}.`);

    let movesThisRound = 0;
    while (!isRoundComplete(game)) {
      movesThisRound++;
      if (movesThisRound > maxMovesPerRound) {
        throw new Error(`Round ${game.state.roundNumber} exceeded ${maxMovesPerRound} moves without completing — likely a non-termination bug.`);
      }
      const currentPlayerId = game.state.players[game.state.currentPlayerIndex].id;
      const move = chooseMove(game, currentPlayerId).choice;
      const before = game.state.players.find(p => p.id === currentPlayerId)!.hand.length;
      game = submitMove(game, currentPlayerId, move);
      const after = game.state.players.find(p => p.id === currentPlayerId)?.hand.length ?? 0;
      log(`${currentPlayerId} played ${move.kind} (hand ${before} -> ${after}).`);
    }
    log(`Round ${game.state.roundNumber} complete.`);

    result = completeRound(game);
    log(`Scores after round ${game.state.roundNumber}: ${JSON.stringify(result.state.scores)}.`);

    if (result.gameOver) {
      log('Game complete.');
      return { finalGame: { ...game, state: result.state }, finalResult: result, events, roundsPlayed };
    }
    game = startNextRound(game, result);
    log(`Round ${game.state.roundNumber} dealt. Bidder: ${game.state.bidderId}.`);
  }
}
