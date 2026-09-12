import { describe, expect, it } from 'vitest';
import { flattenOptionsForHand, withOnlyVisibleHand } from './moveAdapter';
import { discoverLegalMoves } from './roundOrchestrator';
import type { OrchestratedGame } from './roundOrchestrator';
import type { Card, GameState, Player } from '../types';

function card(id: string, rank: Card['rank'], suit: Card['suit']): Card {
  return { id, rank, suit };
}

/**
 * Regression for a real bug reported from live play: with a 2-player opening hand of 12 cards
 * where only the bidder's FIRST 4 are actually visible (App.tsx's pre-opening restriction), a
 * "Build 10" option surfaced even though the highest-ranked VISIBLE card was a 9 — because a
 * Build's "retains" legality check (legalMoves.ts) inspects the whole hand it's given, and here
 * it was being given the true 12-card hand. The card that satisfied "retains" (a second 10) was
 * sitting unseen in position 5+. withOnlyVisibleHand fixes this by truncating the hand BEFORE
 * discovery, so "retains" (and everything else) only ever sees what's actually visible.
 */
describe('withOnlyVisibleHand — closes the "retains" hidden-card leak', () => {
  function makeGame(bidderHand: Card[]): OrchestratedGame {
    const bidder: Player = { id: 'bidder', name: 'Bidder', teamId: null, hand: bidderHand, reserve: [], captured: [] };
    const dealer: Player = { id: 'dealer', name: 'Dealer', teamId: null, hand: [], reserve: [], captured: [] };
    const state: GameState = {
      gameId: 'g',
      mode: '2player',
      roundNumber: 1,
      players: [dealer, bidder],
      teams: [],
      floor: { loose: [card('floor-ace', 'A', 'clubs')], houses: [] },
      deck: [],
      phase: 'revealing',
      currentPlayerIndex: 0,
      turnNumber: 0,
      bidValue: 10,
      bidderId: 'bidder',
      sweepRecords: [],
      scores: {},
      roundScores: {},
      history: []
    };
    return { state, dealerId: 'dealer', gameLengthConfig: { type: 'fixedRounds', rounds: 1 } };
  }

  it('reproduces the bug when discovery runs against the true full hand', () => {
    // Visible-4 tops out at a 9 (no card in it is a 10). A second 10 sits hidden in position 5+,
    // which is exactly what "retains" needs to legalize "Build 10 (with the visible 9 + floor A)".
    const hand = [
      card('v1', '9', 'spades'),
      card('v2', '2', 'hearts'),
      card('v3', '5', 'hearts'),
      card('v4', '6', 'diamonds'),
      card('hidden-10', '10', 'clubs'),
      card('h2', '3', 'hearts'),
      card('h3', '4', 'hearts'),
      card('h4', '7', 'hearts'),
      card('h5', '8', 'hearts'),
      card('h6', 'K', 'hearts'),
      card('h7', 'Q', 'hearts'),
      card('h8', 'J', 'clubs')
    ];
    const game = makeGame(hand);
    const options = flattenOptionsForHand(discoverLegalMoves(game, 'bidder'));
    const buildsUsingVisible9 = options.filter(o => o.kind === 'build' && o.handCardId === 'v1');
    expect(buildsUsingVisible9.length).toBeGreaterThan(0); // confirms the bug is real without the fix
  });

  it('withOnlyVisibleHand hides that option — no Build 10 reachable from a visible-4 that tops out at 9', () => {
    const hand = [
      card('v1', '9', 'spades'),
      card('v2', '2', 'hearts'),
      card('v3', '5', 'hearts'),
      card('v4', '6', 'diamonds'),
      card('hidden-10', '10', 'clubs'),
      card('h2', '3', 'hearts'),
      card('h3', '4', 'hearts'),
      card('h4', '7', 'hearts'),
      card('h5', '8', 'hearts'),
      card('h6', 'K', 'hearts'),
      card('h7', 'Q', 'hearts'),
      card('h8', 'J', 'clubs')
    ];
    const game = makeGame(hand);
    const visibleOnly = withOnlyVisibleHand(game, 'bidder', 4);
    const options = flattenOptionsForHand(discoverLegalMoves(visibleOnly, 'bidder'));
    expect(options.some(o => o.kind === 'build')).toBe(false);
    // With no build/capture reachable, throw is the only remaining option — offered for cards at
    // the bid value. None of the visible 4 is a 10, so nothing is offered at all here either;
    // the point of this test is simply that no build to value 10 ever appears.
  });

  it('still finds the legitimate option when the retaining card IS among the visible 4', () => {
    const hand = [
      card('v1', '9', 'spades'),
      card('v2', '10', 'hearts'), // retains card is visible this time
      card('v3', '5', 'hearts'),
      card('v4', '6', 'diamonds'),
      card('h1', '3', 'hearts'),
      card('h2', '4', 'hearts'),
      card('h3', '7', 'hearts'),
      card('h4', '8', 'hearts'),
      card('h5', 'K', 'hearts'),
      card('h6', 'Q', 'hearts'),
      card('h7', 'J', 'clubs'),
      card('h8', '2', 'clubs')
    ];
    const game = makeGame(hand);
    const visibleOnly = withOnlyVisibleHand(game, 'bidder', 4);
    const options = flattenOptionsForHand(discoverLegalMoves(visibleOnly, 'bidder'));
    const buildsUsingVisible9 = options.filter(o => o.kind === 'build' && o.handCardId === 'v1');
    expect(buildsUsingVisible9.length).toBeGreaterThan(0); // legitimately reachable from visible cards alone
  });
});
