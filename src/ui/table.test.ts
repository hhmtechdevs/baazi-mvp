import { describe, expect, it } from 'vitest';
import { actingPlayerId, seatAt, seatsAround, sideLabel, sideOfPlayer, sidesAreSettled, sidesInPlay, yourOwnerIds } from './table';
import type { GameState, Player, Team } from '../types';

function player(id: string, name: string, hand = 0): Player {
  return {
    id,
    name,
    teamId: null,
    hand: Array.from({ length: hand }, (_, i) => ({ id: `${id}-c${i}`, rank: '2' as const, suit: 'clubs' as const })),
    reserve: [],
    captured: []
  };
}

function state(players: Player[], teams: Team[] = [], mode: GameState['mode'] = '2player'): GameState {
  return {
    gameId: 'g',
    mode,
    roundNumber: 1,
    players,
    teams,
    floor: { loose: [], houses: [] },
    deck: [],
    phase: 'playing',
    currentPlayerIndex: 0,
    turnNumber: 1,
    bidValue: null,
    bidderId: null,
    sweepRecords: [],
    scores: {},
    roundScores: {},
    history: []
  };
}

describe('seating people around the blanket', () => {
  it('sits you near and the other three around you, clockwise from your seat', () => {
    const s = state(
      [player('you', 'You'), player('b', 'Left'), player('c', 'Partner'), player('d', 'Right')],
      [],
      '4player'
    );
    const seats = seatsAround(s, 'you');
    expect(seats.map(x => x.position)).toEqual(['south', 'west', 'north', 'east']);
  });

  it('puts your partner directly opposite you — the same pairing the deal assigns', () => {
    const s = state(
      [player('you', 'You'), player('b', 'Left'), player('c', 'Partner'), player('d', 'Right')],
      [
        { id: 'team-0', name: 'Team 0', playerIds: ['you', 'c'] },
        { id: 'team-1', name: 'Team 1', playerIds: ['b', 'd'] }
      ],
      '4player'
    );
    const seats = seatsAround(s, 'you');
    const opposite = seatAt(seats, 'north')!;
    expect(sideOfPlayer(s, opposite.playerId)).toBe(sideOfPlayer(s, 'you'));
  });

  it('seats two players facing each other, with nobody at the sides', () => {
    const s = state([player('you', 'You'), player('bot', 'Baazigar')]);
    const seats = seatsAround(s, 'you');
    expect(seats.map(x => x.position)).toEqual(['south', 'north']);
    expect(seatAt(seats, 'west')).toBeUndefined();
    expect(seatAt(seats, 'east')).toBeUndefined();
  });

  it('still seats you nearest when you are not the first player in the array', () => {
    const s = state(
      [player('a', 'Left'), player('b', 'Partner'), player('c', 'Right'), player('you', 'You')],
      [],
      '4player'
    );
    expect(seatAt(seatsAround(s, 'you'), 'south')!.playerId).toBe('you');
  });

  it('carries the hand count and whose turn it is straight from the engine state', () => {
    const s = { ...state([player('you', 'You', 5), player('bot', 'Baazigar', 7)]), currentPlayerIndex: 1 };
    const seats = seatsAround(s, 'you');
    expect(seats.map(x => x.handCount)).toEqual([5, 7]);
    expect(seats.map(x => x.isTurn)).toEqual([false, true]);
  });
});

// The seat the table is waiting on is the one that looks awake, so this has to be right for every
// phase a player can be on the hook in — not just ordinary turns.
describe('which seat the table is waiting on', () => {
  const four = [player('you', 'You'), player('left', 'Left'), player('partner', 'Partner'), player('right', 'Right')];

  it('is the player to move during normal play', () => {
    const s = { ...state(four, [], '4player'), currentPlayerIndex: 2 };
    expect(actingPlayerId(s)).toBe('partner');
    expect(seatAt(seatsAround(s, 'you'), 'north')!.isTurn).toBe(true);
  });

  it('is the caller during the call and their opening play', () => {
    const bidding = { ...state(four, [], '4player'), phase: 'bidding' as const, bidderId: 'right', currentPlayerIndex: 0 };
    expect(actingPlayerId(bidding)).toBe('right');
    expect(seatAt(seatsAround(bidding, 'you'), 'east')!.isTurn).toBe(true);

    const revealing = { ...bidding, phase: 'revealing' as const };
    expect(actingPlayerId(revealing)).toBe('right');
  });

  it('wakes exactly one seat, never two', () => {
    for (const phase of ['bidding', 'revealing', 'playing'] as const) {
      const s = { ...state(four, [], '4player'), phase, bidderId: 'left', currentPlayerIndex: 3 };
      expect(seatsAround(s, 'you').filter(seat => seat.isTurn)).toHaveLength(1);
    }
  });

  it('leaves every seat at rest once the round is over', () => {
    const s = { ...state(four, [], '4player'), phase: 'roundEnd' as const, bidderId: 'left' };
    expect(actingPlayerId(s)).toBeUndefined();
    expect(seatsAround(s, 'you').some(seat => seat.isTurn)).toBe(false);
  });
});

describe('sides, for the score line', () => {
  it('is the player themselves in a two-handed game', () => {
    const s = state([player('you', 'You'), player('bot', 'Baazigar')]);
    expect(sideOfPlayer(s, 'you')).toBe('you');
    expect(sideLabel(s, 'bot', 'you')).toBe('Baazigar');
    expect(sidesInPlay(s, 'you')).toEqual(['you', 'bot']);
  });

  it('is the team in a four-handed game, named after the two people on it', () => {
    const s = state(
      [player('you', 'You'), player('b', 'Left'), player('c', 'Partner'), player('d', 'Right')],
      [
        { id: 'team-0', name: 'Team 0', playerIds: ['you', 'c'] },
        { id: 'team-1', name: 'Team 1', playerIds: ['b', 'd'] }
      ],
      '4player'
    );
    expect(sideOfPlayer(s, 'c')).toBe('team-0');
    expect(sideLabel(s, 'team-0', 'you')).toBe('You & Partner');
    expect(sideLabel(s, 'team-1', 'you')).toBe('Left & Right');
    expect(sidesInPlay(s, 'you')[0]).toBe('team-0');
  });

  it('reports unsettled rather than throwing before the deal assigns partnerships', () => {
    const s = state(
      [player('you', 'You'), player('b', 'Left'), player('c', 'Partner'), player('d', 'Right')],
      [],
      '4player'
    );
    expect(sideOfPlayer(s, 'you')).toBeNull();
    expect(sidesAreSettled(s)).toBe(false);
  });

  it('reports settled once teams exist, and always for two-handed play', () => {
    expect(sidesAreSettled(state([player('you', 'You'), player('bot', 'Baazigar')]))).toBe(true);
  });
});

// A house records its owner as an INDIVIDUAL PLAYER id when one player owns it outright, and only
// uses side ids when both sides have a stake (see the House type). Reading ownerSides as if it
// always held side ids painted every four-handed house — including ones you had just built
// yourself — in the opponent's colour, which is what these pin down.
describe('recognising a house as your side\'s', () => {
  const fourUp = state(
    [player('you', 'You'), player('left', 'Left'), player('partner', 'Partner'), player('right', 'Right')],
    [
      { id: 'team-0', name: 'Team 0', playerIds: ['you', 'partner'] },
      { id: 'team-1', name: 'Team 1', playerIds: ['left', 'right'] }
    ],
    '4player'
  );
  const twoUp = state([player('you', 'You'), player('bot', 'Baazigar')]);

  it('counts a house you built yourself', () => {
    expect(yourOwnerIds(fourUp, 'you')).toContain('you');
    expect(yourOwnerIds(twoUp, 'you')).toContain('you');
  });

  it("counts a house your partner built — it belongs to your side too", () => {
    expect(yourOwnerIds(fourUp, 'you')).toContain('partner');
  });

  it('counts your side id, which is how a jointly owned house names an owner', () => {
    expect(yourOwnerIds(fourUp, 'you')).toContain('team-0');
  });

  it('never counts the other side, by either name', () => {
    const mine = yourOwnerIds(fourUp, 'you');
    expect(mine).not.toContain('left');
    expect(mine).not.toContain('right');
    expect(mine).not.toContain('team-1');
    expect(yourOwnerIds(twoUp, 'you')).not.toContain('bot');
  });

  it('names an owner whether it is a player or a side', () => {
    expect(sideLabel(fourUp, 'right', 'you')).toBe('Right');
    expect(sideLabel(fourUp, 'team-1', 'you')).toBe('Left & Right');
    expect(sideLabel(fourUp, 'you', 'you')).toBe('You');
  });
});
