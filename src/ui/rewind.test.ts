import { describe, expect, it } from 'vitest';
import {
  MAX_REMEMBERED,
  moveInto,
  positionReport,
  rememberShared,
  remember,
  reportText,
  snapshotLabel,
  stepTo
} from './rewind';
import {
  discoverLegalMoves,
  startRound,
  submitBid,
  submitMove,
  submitOpeningAction
} from '../engine/roundOrchestrator';
import type { OrchestratedGame } from '../engine/roundOrchestrator';
import { flattenOptionsForHand, toNormalPlayMove, toOpeningAction } from '../engine/moveAdapter';
import { chooseBid, chooseMove, chooseOpeningAction } from '../botStrategy';

function freshGame(): OrchestratedGame {
  return startRound({
    gameId: 'rewind',
    mode: '2player',
    players: [{ id: 'you', name: 'You' }, { id: 'bot', name: 'Baazigar' }],
    dealerId: 'bot',
    gameLengthConfig: { type: 'fixedRounds', rounds: 1 }
  });
}

describe('remembering where the game has been', () => {
  it('keeps one entry per real transition and ignores a repeat of the same state', () => {
    const a = freshGame();
    let history = remember([], a);
    history = remember(history, a);
    expect(history).toHaveLength(1);

    const b = submitBid(a, a.state.bidderId!, 13);
    history = remember(history, b);
    expect(history).toHaveLength(2);
  });

  it('ignores a null game, so a table that has not dealt yet records nothing', () => {
    expect(remember([], null)).toHaveLength(0);
  });

  it('forgets the oldest once the ceiling is reached rather than growing without bound', () => {
    let history: OrchestratedGame[] = [];
    const made: OrchestratedGame[] = [];
    for (let i = 0; i < MAX_REMEMBERED + 10; i++) {
      const snapshot = { ...freshGame(), gameId: `g${i}` } as OrchestratedGame;
      made.push(snapshot);
      history = remember(history, snapshot);
    }
    expect(history).toHaveLength(MAX_REMEMBERED);
    expect(history[history.length - 1]).toBe(made[made.length - 1]);
    expect(history[0]).toBe(made[10]);
  });

  it('clamps a cursor to the positions that exist', () => {
    const history = [freshGame(), freshGame(), freshGame()];
    expect(stepTo(history, -5)).toBe(0);
    expect(stepTo(history, 99)).toBe(2);
    expect(stepTo(history, 1)).toBe(1);
    expect(stepTo([], 3)).toBe(0);
  });
});

describe('rewinding does not disturb the game', () => {
  it('an older snapshot is still a playable game, because nothing was ever mutated', () => {
    // This is the property the whole feature rests on: the engine returns new states rather than
    // editing the one it was given, so a position from ten moves ago can simply be played on from.
    const start = freshGame();
    const history: OrchestratedGame[] = [start];
    let game = start;
    const bidder = game.state.bidderId!;
    game = submitBid(game, bidder, chooseBid(game, bidder).choice);
    history.push(game);
    game = submitOpeningAction(game, bidder, chooseOpeningAction(game, bidder).choice);
    history.push(game);

    let guard = 0;
    while (game.state.phase === 'playing' && guard++ < 8) {
      const seat = game.state.players[game.state.currentPlayerIndex].id;
      game = submitMove(game, seat, chooseMove(game, seat).choice);
      history.push(game);
    }

    // The first snapshot still holds the position it always held — the later play did not reach back.
    expect(history[0]).toBe(start);
    expect(history[0].state.phase).toBe('bidding');
    expect(history[0].state.players.flatMap(p => p.captured)).toHaveLength(0);

    // And an earlier position can be resumed: discovery works from it and its moves still apply.
    const resumeFrom = history[2];
    const seat = resumeFrom.state.players[resumeFrom.state.currentPlayerIndex].id;
    const options = flattenOptionsForHand(discoverLegalMoves(resumeFrom, seat));
    expect(options.length).toBeGreaterThan(0);
    const replayed = submitMove(resumeFrom, seat, toNormalPlayMove(options[0]));
    expect(replayed).not.toBe(resumeFrom);
    expect(resumeFrom.state.players[resumeFrom.state.currentPlayerIndex].hand.length).toBeGreaterThan(
      replayed.state.players.find(p => p.id === seat)!.hand.length
    );
  });
});

describe('the report a position hands back', () => {
  it('carries the state, who is to move, and what the engine offered them', () => {
    let game = freshGame();
    const bidder = game.state.bidderId!;
    game = submitBid(game, bidder, chooseBid(game, bidder).choice);

    const report = positionReport(game);
    expect(report.actingPlayerId).toBe(bidder);
    expect(report.state.phase).toBe('revealing');
    expect(report.bidValue).toBe(game.state.bidValue);
    expect(report.offeredCount).toBe(flattenOptionsForHand(discoverLegalMoves(game, bidder)).length);
    expect(report.offeredCount).toBeGreaterThan(0);
  });

  it('serialises to something a person can paste', () => {
    const text = reportText(freshGame());
    const parsed = JSON.parse(text);
    expect(parsed.state.players).toHaveLength(2);
    expect(parsed.label).toContain('Round 1');
  });

  it('names the opening play, which is the position that keeps going wrong', () => {
    let game = freshGame();
    const bidder = game.state.bidderId!;
    expect(snapshotLabel(game)).toContain('the call');
    game = submitBid(game, bidder, chooseBid(game, bidder).choice);
    expect(snapshotLabel(game)).toContain('the opening play');
  });

  it('captures a thrown discovery instead of taking the table down with it', () => {
    // A position the rules cannot answer is the single most valuable thing to be able to copy out,
    // so the report records the failure rather than propagating it.
    const game = freshGame();
    const broken = {
      ...game,
      state: { ...game.state, phase: 'playing' as const, players: [] }
    } as unknown as OrchestratedGame;
    expect(() => positionReport(broken)).not.toThrow();
  });
});

describe('the opening action is reachable from a report', () => {
  it('a report taken at the opening lists the bid card options that were actually offered', () => {
    let game = freshGame();
    const bidder = game.state.bidderId!;
    game = submitBid(game, bidder, chooseBid(game, bidder).choice);

    const report = positionReport(game);
    const offered = report.offered as Record<string, unknown[]>;
    const everyOption = Object.values(offered).flat();
    expect(everyOption.length).toBe(report.offeredCount);

    // And the report's own list is enough to replay the opening — which is what makes it a
    // reproduction rather than a description.
    const options = flattenOptionsForHand(discoverLegalMoves(game, bidder));
    const after = submitOpeningAction(game, bidder, toOpeningAction(options[0]));
    expect(after.state.phase).toBe('playing');
  });
});

describe('what move produced the position you are looking at', () => {
  it('reads the move out of the two snapshots around it', () => {
    let game = freshGame();
    const history: OrchestratedGame[] = [game];
    const bidder = game.state.bidderId!;
    game = submitBid(game, bidder, chooseBid(game, bidder).choice);
    history.push(game);
    game = submitOpeningAction(game, bidder, chooseOpeningAction(game, bidder).choice);
    history.push(game);

    // The opening play is the third position, and the move into it is the opening action.
    const receipt = moveInto(history, 2);
    expect(receipt).not.toBeNull();
    expect(receipt!.actorId).toBe(bidder);
    expect(receipt!.text.length).toBeGreaterThan(0);
  });

  it('says nothing at the very first position, where no move has been made', () => {
    expect(moveInto([freshGame()], 0)).toBeNull();
    expect(moveInto([], 0)).toBeNull();
  });

  it('says nothing across a deal, rather than describing one round in terms of another', () => {
    const a = freshGame();
    const b = { ...a, state: { ...a.state, roundNumber: 2 } } as OrchestratedGame;
    expect(moveInto([a, b], 1)).toBeNull();
  });
});

describe('a shared table remembers its positions too', () => {
  const snapshot = (n: number) => ({ ...freshGame(), gameId: `rev${n}` }) as OrchestratedGame;

  it('records one position per revision, not one per poll', () => {
    // The envelope is re-parsed from JSON every poll, so the same revision arrives again and again
    // as a brand-new object. Keying on identity would fill the history with duplicates.
    let history = rememberShared([], 4, snapshot(4));
    history = rememberShared(history, 4, snapshot(4));
    history = rememberShared(history, 4, snapshot(4));
    expect(history).toHaveLength(1);

    history = rememberShared(history, 5, snapshot(5));
    expect(history).toHaveLength(2);
    expect(history.map(h => h.revision)).toEqual([4, 5]);
  });

  it('ignores a table with no game dealt yet, and a missing revision', () => {
    expect(rememberShared([], 1, null)).toHaveLength(0);
    expect(rememberShared([], undefined, snapshot(1))).toHaveLength(0);
  });

  it('forgets the oldest rather than growing without bound', () => {
    let history: ReturnType<typeof rememberShared> = [];
    for (let i = 0; i < MAX_REMEMBERED + 5; i++) history = rememberShared(history, i, snapshot(i));
    expect(history).toHaveLength(MAX_REMEMBERED);
    expect(history[0].revision).toBe(5);
  });
})
