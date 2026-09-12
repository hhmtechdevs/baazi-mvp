import { describe, expect, it } from 'vitest';
import {
  authoriseRequest,
  awaitingAi,
  claimSeat,
  createEnvelope,
  expectedActor,
  generateCode,
  GUEST_SEAT,
  HOST_SEAT,
  isUsableEnvelope,
  normaliseCode,
  seatOf,
  seatRecord
} from './protocol';
import type { ActionRequest, TableEnvelope } from './protocol';
import { startTable } from './host';

const HOST = 'session-divjot';
const GUEST = 'session-sydney';
const STRANGER = 'session-someone-else';

function waiting(): TableEnvelope {
  return createEnvelope('K7QM', HOST, 'Sydney');
}

function seated(): TableEnvelope {
  const claim = claimSeat(waiting(), GUEST, 'Sydney');
  if (!claim.ok) throw new Error('fixture: guest could not sit down');
  return claim.envelope;
}

function dealt(): TableEnvelope {
  return startTable(seated());
}

function requestFrom(env: TableEnvelope, sessionId: string, seat: ActionRequest['seat'], overrides: Partial<ActionRequest> = {}): ActionRequest {
  return { id: 'req-1', sessionId, seat, forGameRevision: env.gameRevision, kind: 'bid', payload: 11, ...overrides };
}

describe('room codes are things a person says out loud', () => {
  it('is four characters', () => {
    expect(generateCode()).toHaveLength(4);
  });

  it('never contains the characters people misread', () => {
    for (let i = 0; i < 400; i++) {
      expect(generateCode()).not.toMatch(/[01ILO]/);
    }
  });

  it('accepts what someone actually types — lower case, spaces, and a zero for an O', () => {
    const code = generateCode();
    expect(normaliseCode(code.toLowerCase())).toBe(code);
    expect(normaliseCode(` ${code} `)).toBe(code);
    expect(normaliseCode('k7qm')).toBe('K7QM');
    expect(normaliseCode('K7QO')).toBe('K7QQ'); // a typed O can only have meant Q
    expect(normaliseCode('K7Q1')).toBe('K7QJ'); // likewise a 1 for a J
  });

  it('refuses something that is not a code at all', () => {
    expect(normaliseCode('')).toBeNull();
    expect(normaliseCode('ABC')).toBeNull();
    expect(normaliseCode('ABCDE')).toBeNull();
    expect(normaliseCode('AB!C')).toBeNull();
  });
});

describe('the table seats two people against two computer players', () => {
  it('seats the host and leaves every other seat open to a person', () => {
    const table = waiting();
    expect(seatOf(table, HOST)).toBe(HOST_SEAT);
    // All four are open to people now; whoever hasn't arrived by kick-off becomes a computer seat.
    expect(table.seats.filter(s => s.kind === 'human' && s.sessionId === null)).toHaveLength(3);
    expect(table.status).toBe('waiting');
  });

  it('gives the joiner the partner seat — the one opposite the host', () => {
    const claim = claimSeat(waiting(), GUEST, 'Sydney');
    expect(claim.ok && claim.seat).toBe(GUEST_SEAT);
  });

  it('turns the seats nobody took into computer seats when the game starts', () => {
    const table = startTable(seated());
    expect(seatRecord(table, 'left')!.kind).toBe('ai');
    expect(seatRecord(table, 'right')!.kind).toBe('ai');
    expect(table.seats.filter(s => s.kind === 'ai').every(s => s.sessionId === null)).toBe(true);
    // And the people who did turn up keep their seats.
    expect(seatRecord(table, 'you')!.kind).toBe('human');
    expect(seatRecord(table, GUEST_SEAT)!.kind).toBe('human');
  });

  it('keeps a seat human when somebody is actually in it', () => {
    let table = seated();
    const third = claimSeat(table, 'session-third', 'Ash');
    expect(third.ok && third.seat).toBe('left');
    table = startTable((third as { envelope: TableEnvelope }).envelope);
    expect(seatRecord(table, 'left')!.kind).toBe('human');
    expect(seatRecord(table, 'right')!.kind).toBe('ai');
  });

  it('fills seats so partners are partners at every table size', () => {
    // Two people are on the same team; a third joins the opposition, not the host's side.
    const two = seated();
    expect(seatOf(two, GUEST)).toBe('partner');
    const three = claimSeat(two, 'session-third', 'Ash');
    expect(three.ok && three.seat).toBe('left');
    const four = three.ok ? claimSeat(three.envelope, 'session-fourth', 'Bee') : null;
    expect(four?.ok && four.seat).toBe('right');
  });

  // The engine pairs seats 0+2 and 1+3, and only writes those teams during the main deal. So the
  // thing THIS layer has to get right is the seat ORDER — humans in 0 and 2, computer players in
  // 1 and 3. That the engine then pairs them as intended is asserted in host.test.ts, on a round
  // played far enough for the teams to exist.
  it('orders the seats so the two humans land on one team and the computers on the other', () => {
    const seats = startTable(seated()).seats;
    expect(seats.map(s => s.seat)).toEqual(['you', 'left', 'partner', 'right']);
    expect([seats[0].kind, seats[2].kind]).toEqual(['human', 'human']);
    expect([seats[1].kind, seats[3].kind]).toEqual(['ai', 'ai']);
  });

  it('carries the joiner’s name to their seat', () => {
    expect(seatRecord(seated(), GUEST_SEAT)!.name).toBe('Sydney');
  });

  it('refuses a fifth person — there are only four chairs', () => {
    let table = seated();
    for (const [id, name] of [['s3', 'Ash'], ['s4', 'Bee']] as const) {
      const claim = claimSeat(table, id, name);
      expect(claim.ok).toBe(true);
      if (claim.ok) table = claim.envelope;
    }
    const fifth = claimSeat(table, STRANGER, 'Nosy');
    expect(fifth.ok).toBe(false);
    expect(fifth.ok === false && fifth.reason).toMatch(/full/i);
  });

  it('gives a returning player their own seat back rather than a new one', () => {
    const table = seated();
    const again = claimSeat(table, GUEST);
    expect(again.ok && again.seat).toBe(GUEST_SEAT);
    expect(again.ok && again.rejoined).toBe(true);
    expect(again.ok && again.envelope.revision).toBe(table.revision); // nothing was written
  });

  it('waits rather than dealing while a seat could still fill', () => {
    // Two of four: the host decides when to start, otherwise a four-handed table would deal itself
    // the moment the second person sat down.
    expect(seated().status).toBe('waiting');
  });

  it('is ready to deal the moment the last chair is taken', () => {
    let table = seated();
    for (const [id, name] of [['s3', 'Ash'], ['s4', 'Bee']] as const) {
      const claim = claimSeat(table, id, name);
      if (claim.ok) table = claim.envelope;
    }
    expect(table.status).toBe('ready');
  });
});

describe('rows from before this format are not mistaken for tables', () => {
  it('ignores the prototype’s state shape', () => {
    expect(isUsableEnvelope({ players: [], floor: [], phase: 'waiting', hostPlayerId: 'x' })).toBe(false);
    expect(isUsableEnvelope(null)).toBe(false);
    expect(isUsableEnvelope(waiting())).toBe(true);
  });
});

describe('who is allowed to act', () => {
  it('lets the seat whose turn it is act', () => {
    const table = dealt();
    const actor = expectedActor(table)!;
    const session = actor === HOST_SEAT ? HOST : GUEST;
    if (seatRecord(table, actor)!.kind === 'ai') return; // AI seats are covered below
    expect(authoriseRequest(table, requestFrom(table, session, actor)).ok).toBe(true);
  });

  it('refuses a player acting in a seat that is not theirs', () => {
    const table = dealt();
    // Sydney's session, claiming to be sitting in Divjot's chair.
    const result = authoriseRequest(table, requestFrom(table, GUEST, HOST_SEAT));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/not your seat/i);
  });

  it('refuses a client trying to play a computer seat', () => {
    const table = dealt();
    const result = authoriseRequest(table, requestFrom(table, GUEST, 'left'));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/not played by a person/i);
  });

  it('refuses a player acting out of turn', () => {
    const table = dealt();
    const actor = expectedActor(table)!;
    const other = actor === HOST_SEAT ? GUEST_SEAT : HOST_SEAT;
    const session = other === HOST_SEAT ? HOST : GUEST;
    const result = authoriseRequest(table, requestFrom(table, session, other));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/not that player/i);
  });

  it('refuses an action aimed at a table that has already moved on', () => {
    const table = dealt();
    const actor = expectedActor(table)!;
    const session = actor === HOST_SEAT ? HOST : GUEST;
    const stale = requestFrom(table, session, actor, { forGameRevision: table.gameRevision - 1 });
    const result = authoriseRequest(table, stale);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/moved on/i);
  });

  it('refuses the same action twice', () => {
    const table = { ...dealt(), lastAppliedRequestId: 'req-1' };
    const actor = expectedActor(table)!;
    const session = actor === HOST_SEAT ? HOST : GUEST;
    const result = authoriseRequest(table, requestFrom(table, session, actor, { id: 'req-1' }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/already/i);
  });

  it('refuses any action before the round has been dealt', () => {
    const table = seated();
    const result = authoriseRequest(table, requestFrom(table, GUEST, GUEST_SEAT));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/not been dealt/i);
  });
});

describe('reading whose turn it is off the engine', () => {
  it('names the caller during the call', () => {
    const table = dealt();
    expect(table.game!.state.phase).toBe('bidding');
    expect(expectedActor(table)).toBe(table.game!.state.bidderId);
  });

  it('reports an AI seat as the computer’s to play', () => {
    const table = dealt();
    const actor = expectedActor(table)!;
    const isAi = seatRecord(table, actor)!.kind === 'ai';
    expect(awaitingAi(table)).toBe(isAi ? actor : null);
  });

  it('reports nobody once there is no game', () => {
    expect(expectedActor(waiting())).toBeNull();
    expect(awaitingAi(waiting())).toBeNull();
  });
});
