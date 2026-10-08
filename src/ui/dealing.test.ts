import { describe, expect, it } from 'vitest';
import { chooseDealer, dealerSoThatTheyCall } from './dealing';
import { startRound } from '../engine/roundOrchestrator';

const TWO = ['you', 'bot'];
const FOUR = ['you', 'left', 'partner', 'right'];

describe('choosing a dealer so that a particular seat calls', () => {
  it('picks the seat before the caller, because the call passes to the next seat', () => {
    expect(dealerSoThatTheyCall(TWO, 'you')).toBe('bot');
    expect(dealerSoThatTheyCall(FOUR, 'you')).toBe('right');
    expect(dealerSoThatTheyCall(FOUR, 'partner')).toBe('left');
  });

  it('wraps around the table rather than falling off the start of the list', () => {
    expect(dealerSoThatTheyCall(FOUR, 'left')).toBe('you');
  });

  it('says nothing about a seat that is not at this table', () => {
    expect(dealerSoThatTheyCall(TWO, 'stranger')).toBeNull();
    expect(dealerSoThatTheyCall([], 'you')).toBeNull();
  });

  it('falls back to the random pick when no caller is requested', () => {
    expect(chooseDealer(TWO, null, () => 0)).toBe('you');
    expect(chooseDealer(TWO, null, () => 0.99)).toBe('bot');
  });

  it('ignores the random pick entirely when a caller is requested', () => {
    expect(chooseDealer(TWO, 'you', () => 0)).toBe('bot');
    expect(chooseDealer(TWO, 'you', () => 0.99)).toBe('bot');
  });

  it('actually puts that seat on the call once the engine deals', () => {
    // The claim is about the engine, not about arithmetic, so it is checked against a real deal.
    const players = [{ id: 'you', name: 'You' }, { id: 'bot', name: 'Baazigar' }];
    const game = startRound({
      gameId: 'dealing',
      mode: '2player',
      players,
      dealerId: chooseDealer(TWO, 'you'),
      gameLengthConfig: { type: 'fixedRounds', rounds: 1 }
    });
    expect(game.state.bidderId).toBe('you');
  });

  it('puts the human on the call at a four-handed table too', () => {
    const players = FOUR.map(id => ({ id, name: id }));
    const game = startRound({
      gameId: 'dealing-4',
      mode: '4player',
      players,
      dealerId: chooseDealer(FOUR, 'you'),
      gameLengthConfig: { type: 'fixedRounds', rounds: 1 }
    });
    expect(game.state.bidderId).toBe('you');
  });
});
