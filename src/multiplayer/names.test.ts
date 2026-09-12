import { describe, expect, it } from 'vitest';
import { claimSeat, createEnvelope, SEAT_NAMES, seatOf } from './protocol';
import type { TableEnvelope } from './protocol';
import { startTable } from './host';
import { seatAt, seatsAround, sideLabel } from '../ui/table';

/**
 * "You" is presentation, never identity.
 *
 * A shared table is written down once and read by two people from opposite sides, so a stored name
 * has to be absolute. The word "You" is relative — it means a different person in each browser —
 * and storing it was a real bug: from Sydney's screen the seat across the blanket was labelled
 * "You", because the host seat's NAME was literally the string "You".
 *
 * These are the permanent guard on that. The rule is simple and worth keeping simple: nothing ever
 * writes "You" into game state or into a seat; each browser renders its OWN seat as "You" and
 * everybody else by the name they actually gave.
 */

const DIVJOT = 'session-divjot';
const SYDNEY = 'session-sydney';

function sharedTable(hostName?: string, guestName?: string): TableEnvelope {
  const claim = claimSeat(createEnvelope('K7QM', DIVJOT, hostName), SYDNEY, guestName);
  if (!claim.ok) throw new Error('fixture: could not seat the guest');
  return startTable(claim.envelope);
}

describe('"You" is never stored as a name', () => {
  it('is not a default seat name anywhere', () => {
    for (const name of Object.values(SEAT_NAMES)) {
      expect(name).not.toBe('You');
    }
  });

  it('is not in a freshly created table, before anyone has typed a name', () => {
    const table = createEnvelope('K7QM', DIVJOT);
    expect(table.seats.map(s => s.name)).not.toContain('You');
  });

  it('is not in the engine state once the round is dealt', () => {
    const table = sharedTable('Divjot', 'Sydney');
    expect(table.game!.state.players.map(p => p.name)).not.toContain('You');
  });

  it('is not in the engine state when nobody supplied a name at all', () => {
    const table = sharedTable();
    expect(table.game!.state.players.map(p => p.name)).not.toContain('You');
  });
});

describe('each browser reads the table from its own side', () => {
  const table = sharedTable('Divjot', 'Sydney');
  const state = table.game!.state;

  it('shows Divjot himself as You, and Sydney by name', () => {
    const seats = seatsAround(state, seatOf(table, DIVJOT)!);
    expect(seatAt(seats, 'south')!.playerId).toBe('you');
    expect(seatAt(seats, 'north')!.name).toBe('Sydney');
    expect(sideLabel(state, 'you', 'you')).toBe('You');
    expect(sideLabel(state, 'partner', 'you')).toBe('Sydney');
  });

  it('shows Sydney herself as You, and Divjot by name', () => {
    const mine = seatOf(table, SYDNEY)!;
    const seats = seatsAround(state, mine);
    expect(seatAt(seats, 'south')!.playerId).toBe('partner');
    expect(seatAt(seats, 'north')!.name).toBe('Divjot');
    expect(sideLabel(state, 'partner', mine)).toBe('You');
    expect(sideLabel(state, 'you', mine)).toBe('Divjot');
  });

  it('never shows two seats called You from either side', () => {
    for (const session of [DIVJOT, SYDNEY]) {
      const mine = seatOf(table, session)!;
      // How the table actually renders a seat: your own is "You", everyone else by name.
      const rendered = seatsAround(state, mine).map(s => (s.playerId === mine ? 'You' : s.name));
      expect(rendered.filter(n => n === 'You')).toHaveLength(1);
      expect(new Set(rendered).size).toBe(rendered.length); // and no two seats share a label
    }
  });

  it('names the other human relative to whoever is reading', () => {
    // The same seat, read from both sides — it is "Sydney" to Divjot and "You" to Sydney.
    expect(sideLabel(state, 'partner', 'you')).toBe('Sydney');
    expect(sideLabel(state, 'partner', 'partner')).toBe('You');
    expect(sideLabel(state, 'you', 'partner')).toBe('Divjot');
    expect(sideLabel(state, 'you', 'you')).toBe('You');
  });

  it('mirrors the side seats, so each player sees the table from where they sit', () => {
    const divjot = seatsAround(state, 'you');
    const sydney = seatsAround(state, 'partner');
    // Whoever is on Divjot's left is on Sydney's right — they face each other.
    expect(seatAt(divjot, 'west')!.playerId).toBe(seatAt(sydney, 'east')!.playerId);
    expect(seatAt(divjot, 'east')!.playerId).toBe(seatAt(sydney, 'west')!.playerId);
  });
});
