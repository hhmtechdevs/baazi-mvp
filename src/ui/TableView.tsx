import { useEffect, useMemo, useState } from 'react';
import { CardBack, PlayingCard } from './Card';
import { labelLegalOptions } from './describeOption';
import { House } from './House';
import { Hand } from './Hand';
import { LooseFloor } from './LooseFloor';
import { seatAt, seatsAround, sideLabel, sidesAreSettled, sidesInPlay, yourOwnerIds } from './table';
import type { Seat } from './table';
import { VISIBLE_PRE_OPENING_CARD_COUNT, safeBidValues } from './useBaaziGame';
import { discoverLegalMoves } from '../engine/roundOrchestrator';
import type { OrchestratedGame, RoundCompletionResult } from '../engine/roundOrchestrator';
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

/** Name plus cards-remaining-in-hand — the count updates straight off the engine's hand array, and
 * never reveals which cards those are. */
export function PlayerChip({
  name,
  handCount,
  isTurn = false,
  thinking = false,
  className = ''
}: {
  name: string;
  handCount: number;
  isTurn?: boolean;
  thinking?: boolean;
  className?: string;
}) {
  return (
    <div className={`baazi-player-chip ${isTurn ? 'is-turn' : ''} ${className}`}>
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
function OpponentSeat({ seat, thinking }: { seat: Seat; thinking: boolean }) {
  return (
    <div className={`baazi-seat is-${seat.position}`}>
      <PlayerChip name={seat.name} handCount={seat.handCount} isTurn={seat.isTurn} thinking={thinking} />
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
  onFinishRound?: () => void;
  onNextRound?: () => void;
  /** Anything that should float over the middle of the blanket — a waiting notice, a refusal. */
  notice?: React.ReactNode;
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

  // Labels are resolved per rendered set, so suits are only added back where two options would
  // otherwise read identically (see labelLegalOptions).
  const openingOptions = Object.values(openingOptionsForMe).flat();
  const openingLabels = labelLegalOptions(openingOptions, state);
  const openingChoices = openingOptions.map((option, i) => ({ option, label: openingLabels[i] }));
  const moveOptions = (selectedCardId && legalMovesForMe[selectedCardId]) || [];
  const moveLabels = labelLegalOptions(moveOptions, state);
  const moveChoices = moveOptions.map((option, i) => ({ option, label: moveLabels[i] }));

  const floorIsBare = state.floor.loose.length === 0 && state.floor.houses.length === 0;

  return (
    <div className="baazi-app baazi-blanket">
      <header className="baazi-topbar">
        <div className="baazi-status">
          Round {state.roundNumber} · {phaseLabel(state, mySeat, thinkingPlayerId)}
        </div>

        <div className="baazi-scoreline">
          {sides.map(side => (
            <div key={side} className="baazi-side-score">
              <span className="baazi-side-name">{sideLabel(state, side, mySeat)}</span>
              <span className="baazi-side-total">{state.scores[side] ?? 0}</span>
              {runningTally && (runningTally[side]?.total ?? 0) > 0 && (
                <span className="baazi-side-round">
                  +{runningTally[side].total}
                  {runningTally[side].sweepPoints > 0 &&
                    ` (${runningTally[side].cardPoints} + ${runningTally[side].sweepPoints} Seep)`}
                </span>
              )}
            </div>
          ))}
        </div>

        <div className="baazi-topbar-end">
          {state.bidValue !== null && (state.phase === 'revealing' || state.phase === 'playing') && (
            <div className="baazi-call-badge">CALL {state.bidValue}</div>
          )}
        </div>
      </header>

      <div className={`baazi-table is-${state.players.length}-up`}>
        {(['north', 'west', 'east'] as const).map(position => {
          const seat = seatAt(seats, position);
          if (!seat) return null;
          return <OpponentSeat key={position} seat={seat} thinking={thinkingPlayerId === seat.playerId} />;
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

          {state.floor.loose.length > 0 && <LooseFloor cards={state.floor.loose} />}
        </div>

        <div className="baazi-near">
          {isPreOpening && (
            <p className="baazi-hand-hint">
              First {VISIBLE_PRE_OPENING_CARD_COUNT} only — the rest turn face-up after your opening move.
            </p>
          )}
          <div className="baazi-hand">
            <Hand
              cards={sortedForDisplay(isPreOpening ? me.hand.slice(0, VISIBLE_PRE_OPENING_CARD_COUNT) : me.hand)}
              selectedId={selectedCardId}
              isActive={isYourMove}
              renderCard={card => {
                const options = legalMovesForMe[card.id] ?? [];
                const clickable = isMyTurn && options.length > 0;
                return (
                  <PlayingCard
                    card={card}
                    selected={selectedCardId === card.id}
                    dimmed={isMyTurn && options.length === 0}
                    onClick={clickable ? () => setSelectedCardId(c => (c === card.id ? null : card.id)) : undefined}
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
            <PlayerChip name="You" handCount={me.hand.length} isTurn={isYourMove} className="is-self" />

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

            {isMyOpening && (
              <div className="baazi-choice-row">
                {openingChoices.map(({ option, label }, i) => (
                  <button key={i} className="baazi-choice-button" onClick={() => props.onOpeningAction(toOpeningAction(option))}>
                    {label}
                  </button>
                ))}
              </div>
            )}

            {isMyTurn && selectedCardId && moveChoices.length > 0 && (
              <div className="baazi-choice-row">
                {moveChoices.map(({ option, label }, i) => (
                  <button key={i} className="baazi-choice-button" onClick={() => props.onMove(toNormalPlayMove(option))}>
                    {label}
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
