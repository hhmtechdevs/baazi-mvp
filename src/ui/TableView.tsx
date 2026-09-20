import { useEffect, useMemo, useRef, useState } from 'react';
import { CardBack, PlayingCard } from './Card';
import { planForCard } from './cardChoices';
import { House } from './House';
import { Hand } from './Hand';
import { LooseFloor } from './LooseFloor';
import { matchTally, seatAt, seatsAround, sideLabel, sidesAreSettled, sidesInPlay, yourOwnerIds } from './table';
import type { Seat } from './table';
import { VISIBLE_PRE_OPENING_CARD_COUNT, safeBidValues } from './useBaaziGame';
import { discoverLegalMoves } from '../engine/roundOrchestrator';
import type { LegalOption, OrchestratedGame, RoundCompletionResult } from '../engine/roundOrchestrator';
import { toNormalPlayMove, toOpeningAction, withOnlyVisibleHand } from '../engine/moveAdapter';
import type { NormalPlayMove } from '../engine/moveExecution';
import { computeRoundScoreBreakdown } from '../engine/scoring';
import type { Card, GameState, OpeningAction } from '../types';

/**
 * The table itself — the blanket, the four seats, the floor, your hand.
 *
 * It takes the seat YOU are in as a parameter rather than assuming it. Locally that is always the
 * near seat; in a shared game it depends on which chair you were given when you joined. Everything
 * downstream — which hand is face up, whose nameplate leans in, which houses read as yours — falls
 * out of that one value, so a guest sees the table from their own side of the blanket rather than
 * from the host's.
 *
 * It renders whatever game it is handed and never advances one. Deciding what happens next belongs
 * to the caller: the local hook for Practice, the authority for a shared table.
 */

const RANK_ORDER: Record<Card['rank'], number> = {
  A: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13
};

/** A rank-sorted copy for DISPLAY only — never reorders the underlying hand array itself, which
 * elsewhere (see VISIBLE_PRE_OPENING_CARD_COUNT / withOnlyVisibleHand) is relied on to reflect
 * actual deal order for the opening-visibility rule. This only changes the order cards render in,
 * left to right; each card keeps its own id, so selection/legal-move lookups are unaffected. */
function sortedForDisplay(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => RANK_ORDER[a.rank] - RANK_ORDER[b.rank]);
}

/**
 * How much of this turn is left, as 1 → 0, refreshed each frame.
 *
 * Driven from the turn's start time rather than from a local countdown, because the start time is
 * written on the table itself: both players' rings therefore empty together, and a refresh picks up
 * the sweep where it actually is instead of restarting it.
 */
function useCountdown(startedAt: number | undefined, limitMs: number | undefined): number | null {
  const [fraction, setFraction] = useState<number | null>(null);
  const frame = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!startedAt || !limitMs) {
      setFraction(null);
      return undefined;
    }
    const step = () => {
      const left = Math.max(0, Math.min(1, (startedAt + limitMs - Date.now()) / limitMs));
      setFraction(left);
      if (left > 0) frame.current = requestAnimationFrame(step);
    };
    step();
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [startedAt, limitMs]);

  return fraction;
}

/** Name plus cards-remaining-in-hand — the count updates straight off the engine's hand array, and
 * never reveals which cards those are. */
export function PlayerChip({
  name,
  handCount,
  isTurn = false,
  thinking = false,
  className = '',
  turnStartedAt,
  turnLimitMs
}: {
  name: string;
  handCount: number;
  isTurn?: boolean;
  thinking?: boolean;
  className?: string;
  /** When this seat's turn began (epoch ms) and how long it gets. Supplied together or not at all;
   * without them the nameplate simply has no ring. */
  turnStartedAt?: number;
  turnLimitMs?: number;
}) {
  const fraction = useCountdown(isTurn ? turnStartedAt : undefined, turnLimitMs);

  return (
    <div
      className={`baazi-player-chip ${isTurn ? 'is-turn' : ''} ${fraction !== null ? 'has-clock' : ''} ${className}`}
      style={fraction !== null ? ({ '--turn-left': String(fraction) } as React.CSSProperties) : undefined}
    >
      <div className="baazi-player-avatar">
        <span>{name.charAt(0).toUpperCase()}</span>
      </div>
      <span className="baazi-player-hand-count" title={`${handCount} cards in hand`}>
        {handCount}
      </span>
      <span className="baazi-player-name">{name}</span>
      {/* Separate from the name rather than appended to it, so a seat with only room for an
          avatar can still show that its player is mid-decision. */}
      {thinking && (
        <span className="baazi-player-thinking" title={`${name} is thinking`} aria-label="thinking">
          ···
        </span>
      )}
    </div>
  );
}

/** Somebody else's place at the blanket: who they are, and their cards face down in front of them. */
function OpponentSeat({
  seat,
  thinking,
  turnStartedAt,
  turnLimitMs
}: {
  seat: Seat;
  thinking: boolean;
  turnStartedAt?: number;
  turnLimitMs?: number;
}) {
  return (
    <div className={`baazi-seat is-${seat.position}`}>
      <PlayerChip
        name={seat.name}
        handCount={seat.handCount}
        isTurn={seat.isTurn}
        thinking={thinking}
        turnStartedAt={turnStartedAt}
        turnLimitMs={turnLimitMs}
      />
      <div className="baazi-seat-cards">
        <div className="baazi-seat-cards-run">
          {Array.from({ length: seat.handCount }, (_, i) => (
            <CardBack key={i} />
          ))}
        </div>
      </div>
    </div>
  );
}

const SUIT_SYMBOL: Record<Card['suit'], string> = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };

/** "3♥" — how a card is named back to the player who is holding it. */
function cardName(card: Card): string {
  return `${card.rank}${SUIT_SYMBOL[card.suit]}`;
}

/**
 * Whose turn it is, said in words, right above the hand — where the player is actually looking.
 *
 * The first family game showed that a gold ring on a nameplate at the edge of the screen is not
 * enough for everyone to notice that it is their go. So on your turn this says YOUR TURN, says what
 * to do next in plain words ("Tap a card to play it"), and carries the turn's clock as a slow bar
 * directly underneath — the time belongs to the turn, so it sits with the turn. When it is someone
 * else's go, the same place says so quietly, so there is never a moment where nobody seems to be
 * playing.
 *
 * The clock is meant to say "it's your turn, and you have time", not "hurry": no numbers ticking
 * down, no colour change as it runs low, nothing that flashes. Its height is held constant whether
 * or not there is anything to say, so the hand beneath never jumps when the turn passes.
 */
function TurnBanner({
  yourMove,
  actingName,
  prompt,
  note,
  turnStartedAt,
  turnLimitMs
}: {
  yourMove: boolean;
  actingName: string | null;
  prompt: string | null;
  note: string | null;
  turnStartedAt?: number;
  turnLimitMs?: number;
}) {
  const fraction = useCountdown(turnStartedAt, turnLimitMs);
  const title = yourMove ? 'YOUR TURN' : actingName ? `${actingName}’s turn` : null;

  return (
    <div className={`baazi-turn-banner ${yourMove ? 'is-yours' : 'is-theirs'}`} role="status" aria-live="polite">
      {title && <div className="baazi-turn-title">{title}</div>}
      {yourMove && prompt && <div className="baazi-turn-prompt">{prompt}</div>}
      {title && fraction !== null && (
        <div className="baazi-turn-clock" aria-hidden="true">
          <span style={{ transform: `scaleX(${fraction})` }} />
        </div>
      )}
      {note && <div className="baazi-turn-note">{note}</div>}
    </div>
  );
}

export interface TableProps {
  game: OrchestratedGame;
  /** The engine player id of the seat this browser is playing. */
  mySeat: string;
  /** Whoever is mid-decision, so their nameplate can show it. */
  thinkingPlayerId: string | null;
  /** True when this browser may act — false while a shared table is waiting on someone else. */
  canAct: boolean;
  onBid: (value: number) => void;
  onOpeningAction: (action: OpeningAction) => void;
  onMove: (move: NormalPlayMove) => void;
  roundComplete: boolean;
  lastRoundResult: RoundCompletionResult | null;
  /** What each side scored in the round just played, for the tally at the top. Survives the deal of
   * the next round, which is exactly what `lastRoundResult` does not do. */
  lastRoundScores?: Record<string, number> | null;
  onFinishRound?: () => void;
  onNextRound?: () => void;
  /** Anything that should float over the middle of the blanket — a waiting notice, a refusal. */
  notice?: React.ReactNode;
  /** Shown on a shared table so you can get up from it. Absent for Practice, which has no table to
   * leave — you just stop. */
  onLeave?: () => void;
  /** The game's code, kept on screen next to Leave so getting up is reversible: it is the one thing
   * you need to sit back down, and nobody memorises four characters they only saw once. */
  tableCode?: string;
  /** When the current turn began (epoch ms), and how long the seat on turn gets. Drives the ring
   * around the active nameplate. Omitted for Practice, which has no shared clock. */
  turnStartedAt?: number;
  turnLimitMs?: number;
}

export function TableView(props: TableProps) {
  const { game, mySeat, thinkingPlayerId, canAct } = props;
  const state = game.state;
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedCardId(null);
  }, [state.phase, state.currentPlayerIndex, state.turnNumber]);

  const legalMovesForMe = useMemo(() => {
    if (state.phase !== 'playing') return {};
    if (state.players[state.currentPlayerIndex]?.id !== mySeat) return {};
    return discoverLegalMoves(game, mySeat);
  }, [game, state, mySeat]);

  const openingOptionsForMe = useMemo(() => {
    if (state.phase !== 'revealing' || state.bidderId !== mySeat) return {};
    // Discover against a hand truncated to the visible first 4 (see withOnlyVisibleHand) — not a
    // filter applied after the fact. A build's "retains" legality check inspects the whole hand
    // it's given, so discovering against the true 12-card hand could surface an option that's
    // only legal because of a card the player hasn't looked at yet.
    return discoverLegalMoves(withOnlyVisibleHand(game, mySeat, VISIBLE_PRE_OPENING_CARD_COUNT), mySeat);
  }, [game, state, mySeat]);

  const me = state.players.find(p => p.id === mySeat);
  if (!me) return null;

  const isMyTurn = canAct && state.phase === 'playing' && state.players[state.currentPlayerIndex]?.id === mySeat;
  const isMyBid = canAct && state.phase === 'bidding' && state.bidderId === mySeat;
  const isMyOpening = canAct && state.phase === 'revealing' && state.bidderId === mySeat;
  // Before the opening move, the bidder has only looked at their first 4 dealt cards.
  const isPreOpening =
    (state.phase === 'bidding' || state.phase === 'revealing') && state.bidderId === mySeat;

  const seats = seatsAround(state, mySeat);
  const isYourMove = seatAt(seats, 'south')?.isTurn ?? false;
  const yourOwners = yourOwnerIds(state, mySeat);
  const sides = sidesInPlay(state, mySeat);
  // In four-handed play the default partnerships are only written during the main deal, so for the
  // short stretch between the call and the opening action a round-1 state has no sides at all —
  // and asking the engine to break a score down by side would (correctly) fail loudly.
  const runningTally = sidesAreSettled(state) ? computeRoundScoreBreakdown(state) : null;
  // A match is always two sides, so the gap between them is simply "the lead" — see matchTally.
  const tally = matchTally(state, sides, mySeat, props.lastRoundScores);

  // ---- one interaction, for the opening play and every turn after it ----------------------------
  //
  // The engine says what each card may legally do; the player chooses. A tap on a card with exactly
  // one legal move plays it. A tap on a card with several shows those several — and only those —
  // as COLLECT / CEMENT / ADD TO HOUSE / BUILD HOUSE / PLAY CARD. Nothing here decides legality:
  // see cardChoices.ts.
  //
  // The opening play used to show every option across all four visible cards as one flat list; it
  // now works exactly like a normal turn, so there is one way to play a card, not two.
  const isChoosingCard = isMyOpening || isMyTurn;
  const optionsByCard: Record<string, LegalOption[]> = isMyOpening
    ? openingOptionsForMe
    : isMyTurn
      ? legalMovesForMe
      : {};

  const play = (option: LegalOption) => {
    setSelectedCardId(null);
    if (isMyOpening) props.onOpeningAction(toOpeningAction(option));
    else props.onMove(toNormalPlayMove(option));
  };

  const tapCard = (card: Card) => {
    const plan = planForCard(optionsByCard[card.id], state);
    if (plan.kind === 'direct') play(plan.choice.option);
    else if (plan.kind === 'choose') setSelectedCardId(current => (current === card.id ? null : card.id));
  };

  const playableIds = new Set(
    isChoosingCard ? Object.entries(optionsByCard).filter(([, opts]) => opts.length > 0).map(([id]) => id) : []
  );

  const selectedCard = me.hand.find(c => c.id === selectedCardId) ?? null;
  const selectedPlan = selectedCard ? planForCard(optionsByCard[selectedCard.id], state) : null;
  const choices = selectedPlan?.kind === 'choose' ? selectedPlan.choices : [];

  const floorIsBare = state.floor.loose.length === 0 && state.floor.houses.length === 0;

  return (
    <div className="baazi-app baazi-blanket">
      <header className="baazi-topbar">
        <div className="baazi-status">
          Round {state.roundNumber} · {phaseLabel(state, mySeat, thinkingPlayerId)}
        </div>

        <div className="baazi-scores">
          <div className="baazi-scoreline">
            {sides.map(side => (
              <div key={side} className="baazi-side-score">
                <span className="baazi-side-name">{sideLabel(state, side, mySeat)}</span>
                <span className="baazi-side-total">{state.scores[side] ?? 0}</span>
                {runningTally && (runningTally[side]?.total ?? 0) > 0 && (
                  <span className="baazi-side-round">
                    +{runningTally[side].total}
                    {/* The breakdown is the first thing to go when the bar is narrow — what a side is
                        up THIS round is the part worth keeping on a phone, so it gets its own span. */}
                    {runningTally[side].sweepPoints > 0 && (
                      <span className="baazi-side-round-detail">
                        {' '}
                        ({runningTally[side].cardPoints} + {runningTally[side].sweepPoints} Seep)
                      </span>
                    )}
                  </span>
                )}
              </div>
            ))}
          </div>

          {/* Who is ahead, and what the last round was worth. Nothing to say in round 1, so it is
              simply not there rather than showing a row of zeroes. */}
          {(tally.lead || tally.lastRound) && (
            <div className="baazi-match-tally">
              {tally.lead && <span className="baazi-tally-lead">{tally.lead}</span>}
              {tally.lead && tally.lastRound && <span aria-hidden="true">·</span>}
              {tally.lastRound && <span>{tally.lastRound}</span>}
            </div>
          )}
        </div>

        <div className="baazi-topbar-end">
          {props.tableCode && <span className="baazi-table-code" title="This game's code">{props.tableCode}</span>}
          {props.onLeave && (
            <button className="baazi-table-leave" onClick={props.onLeave}>
              Leave
            </button>
          )}
          {state.bidValue !== null && (state.phase === 'revealing' || state.phase === 'playing') && (
            <div className="baazi-call-badge">CALL {state.bidValue}</div>
          )}
        </div>
      </header>

      <div className={`baazi-table is-${state.players.length}-up`}>
        {(['north', 'west', 'east'] as const).map(position => {
          const seat = seatAt(seats, position);
          if (!seat) return null;
          return (
            <OpponentSeat
              key={position}
              seat={seat}
              thinking={thinkingPlayerId === seat.playerId}
              turnStartedAt={props.turnStartedAt}
              turnLimitMs={props.turnLimitMs}
            />
          );
        })}

        <div className="baazi-centre">
          {floorIsBare && <span className="baazi-floor-empty">Floor is empty</span>}

          {state.floor.houses.length > 0 && (
            <div className="baazi-houses">
              {state.floor.houses.map(house => (
                <House
                  key={house.id}
                  house={house}
                  yourOwnerIds={yourOwners}
                  labelForOwner={owner => sideLabel(state, owner, mySeat)}
                />
              ))}
            </div>
          )}

          {/* The floor is dealt face down and only turned over once the call is made — the engine's
              own revealFloor step is exactly that transition, bidding -> revealing. Showing it
              face up during the call handed the caller four cards of information they are not
              meant to have yet. */}
          {state.floor.loose.length > 0 && (
            <LooseFloor cards={state.floor.loose} faceDown={state.phase === 'bidding'} />
          )}
        </div>

        <div className="baazi-near">
          <TurnBanner
            yourMove={isYourMove}
            actingName={seats.find(s => s.isTurn && !s.isYou)?.name ?? null}
            // Once a card is chosen, the question moves down to sit with its answers (below the
            // hand). Up here it was covered by the very card it named, which rises as it's picked.
            prompt={isMyBid ? 'Choose your call' : isChoosingCard && !selectedCard ? 'Tap a card to play it' : null}
            note={
              isPreOpening && me.hand.length > VISIBLE_PRE_OPENING_CARD_COUNT
                ? `You can see your first ${VISIBLE_PRE_OPENING_CARD_COUNT} cards — the rest turn over after your opening play.`
                : null
            }
            turnStartedAt={props.turnStartedAt}
            turnLimitMs={props.turnLimitMs}
          />
          <div className={`baazi-hand ${isYourMove ? 'is-live' : 'is-waiting'}`}>
            <Hand
              cards={sortedForDisplay(isPreOpening ? me.hand.slice(0, VISIBLE_PRE_OPENING_CARD_COUNT) : me.hand)}
              selectedId={selectedCardId}
              playableIds={playableIds}
              isActive={isYourMove}
              renderCard={card => {
                const playable = playableIds.has(card.id);
                return (
                  <PlayingCard
                    card={card}
                    selected={selectedCardId === card.id}
                    playable={playable}
                    // Quiet only the cards that genuinely can't be played while a card is being
                    // chosen; outside your turn the whole hand rests, rather than every card
                    // looking like a mistake.
                    dimmed={isChoosingCard && !playable}
                    onClick={playable ? () => tapCard(card) : undefined}
                  />
                );
              }}
            />
            {isPreOpening && me.hand.length > VISIBLE_PRE_OPENING_CARD_COUNT && (
              <div className="baazi-hand-hidden">
                {me.hand.slice(VISIBLE_PRE_OPENING_CARD_COUNT).map(card => (
                  <CardBack key={`hidden-${card.id}`} />
                ))}
              </div>
            )}
          </div>

          {/* Identity and the turn's choices share the bottom strip, so options never push the
              table around or crowd the tops of the cards. */}
          <div className="baazi-bottom-bar">
            <PlayerChip
              name="You"
              handCount={me.hand.length}
              isTurn={isYourMove}
              className="is-self"
              turnStartedAt={props.turnStartedAt}
              turnLimitMs={props.turnLimitMs}
            />

            {isMyBid && (
              <div className="baazi-choice-row">
                <span className="baazi-choice-label">Call</span>
                {safeBidValues(game, mySeat).map(v => (
                  <button key={v} className="baazi-choice-button" onClick={() => props.onBid(v)}>
                    {v}
                  </button>
                ))}
              </div>
            )}

            {/* Only when a card has more than one legal move — a card with exactly one is simply
                played on the tap, so there is nothing to choose. */}
            {choices.length > 0 && (
              <div className="baazi-choice-row" role="group" aria-label={`What to do with ${cardName(selectedCard!)}`}>
                <span className="baazi-choice-caption">What do you want to do with {cardName(selectedCard!)}?</span>
                {choices.map((choice, i) => (
                  <button
                    key={i}
                    className={`baazi-choice-button is-${choice.verb.toLowerCase().replace(/ /g, '-')}`}
                    onClick={() => play(choice.option)}
                  >
                    <span className="baazi-choice-verb">{choice.verb}</span>
                    {choice.detail && <span className="baazi-choice-detail">{choice.detail}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {props.notice}

        {/* End-of-round business floats over the middle of the blanket rather than taking a row of
            its own, so the table underneath never rearranges itself to make space. */}
        {props.roundComplete && !props.lastRoundResult && props.onFinishRound && (
          <div className="baazi-interlude">
            <p>Round complete.</p>
            <button className="baazi-primary-button" onClick={props.onFinishRound}>
              See the score
            </button>
          </div>
        )}

        {props.lastRoundResult && (
          <div className="baazi-interlude">
            <p>
              {Object.entries(props.lastRoundResult.breakdown)
                .map(([side, b]) => `${sideLabel(state, side, mySeat)} +${b.total}`)
                .join('  ·  ')}
            </p>
            {props.lastRoundResult.gameOver ? (
              <p className="baazi-game-over-line">{gameOverLine(state, sides, mySeat)}</p>
            ) : (
              props.onNextRound && (
                <button className="baazi-primary-button" onClick={props.onNextRound}>
                  Deal the next round
                </button>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function gameOverLine(state: GameState, sides: string[], mySeat: string): string {
  const scored = sides.map(side => ({ side, score: state.scores[side] ?? 0 })).sort((a, b) => b.score - a.score);
  if (scored.length < 2 || scored[0].score === scored[1].score) return "It's a draw.";
  const winner = sideLabel(state, scored[0].side, mySeat);
  return winner === 'You' ? 'You win the game.' : `${winner} wins the game.`;
}

function phaseLabel(state: GameState, mySeat: string, thinkingPlayerId: string | null): string {
  const nameOf = (id: string | null | undefined) => {
    if (id === mySeat) return 'Your';
    const player = state.players.find(p => p.id === id);
    return player ? `${player.name}'s` : '';
  };
  if (state.phase === 'bidding') return `${nameOf(state.bidderId)} call`;
  if (state.phase === 'revealing') return `${nameOf(state.bidderId)} opening play`;
  if (state.phase === 'playing') {
    const acting = state.players[state.currentPlayerIndex]?.id ?? thinkingPlayerId;
    return acting === mySeat ? 'Your turn' : `${nameOf(acting)} turn`;
  }
  if (state.phase === 'roundEnd') return 'Round complete';
  if (state.phase === 'gameEnd') return 'Game complete';
  return state.phase;
}
