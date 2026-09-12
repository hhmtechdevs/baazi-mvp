export type Suit = 'hearts' | 'diamonds' | 'clubs' | 'spades'

export type Rank =
  | 'A'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | '10'
  | 'J'
  | 'Q'
  | 'K'

export interface Card {
  id: string
  rank: Rank
  suit: Suit
}

export interface Player {
  id: string
  name: string
  teamId: string | null
  hand: Card[]
  reserve: Card[]
  captured: Card[]
}

export interface Team {
  id: string
  name: string
  playerIds: [string, string]
}

export interface House {
  id: string
  /**
   * 1 entry = sole ownership (an individual player id — every ordinary, non-cemented house has
   * exactly one). 2 entries = joint ownership by both sides (side ids: player id in 2-player
   * mode, team id in 4-player mode) — this only ever arises when Cement/Add-to-Fixed crosses
   * from one side to the other; see the Ingredient 4/5 Combine architecture notes.
   */
  ownerSides: string[]
  cards: Card[]
  captureValue: number
  isCemented: boolean
}

export interface Floor {
  loose: Card[]
  houses: House[]
}

export type GamePhase =
  | 'dealing'
  | 'bidding'
  | 'revealing'
  | 'opening'
  | 'playing'
  | 'roundEnd'
  | 'gameEnd'

export interface SweepRecord {
  playerId: string
  teamId: string | null
  roundNumber: number
  isOpeningPlay: boolean
  isFinalPlay: boolean
}

export interface GameState {
  gameId: string
  mode: '2player' | '4player'
  roundNumber: number
  players: Player[]
  teams: Team[]
  floor: Floor
  deck: Card[]
  phase: GamePhase
  currentPlayerIndex: number
  turnNumber: number
  bidValue: number | null
  bidderId: string | null
  sweepRecords: SweepRecord[]
  scores: Record<string, number>
  roundScores: Record<string, number>
  history: GameEvent[]
}

export type CaptureTarget =
  | { type: 'loose'; cardId: string }
  | { type: 'house'; houseId: string }

export type OpeningAction =
  | { type: 'build'; builderCardId: string; floorCardIds: string[] }
  | { type: 'capture'; bidCardId: string; targets: CaptureTarget[] }
  | { type: 'throw'; bidCardId: string }

export type GameAction =
  | { type: 'DEAL' }
  | { type: 'BID'; playerId: string; value: number }
  | { type: 'REVEAL_FLOOR' }
  | { type: 'OPENING_PLAY'; playerId: string; cardId: string }
  | { type: 'PLAY_CARD'; playerId: string; cardId: string }
  | { type: 'END_TURN'; playerId: string }
  | { type: 'SWAP_RESERVE'; playerId: string }
  | { type: 'SCORE_ROUND' }
  | { type: 'NEXT_ROUND' }
  | { type: 'END_GAME' }

export interface GameEvent {
  type:
    | 'card_played'
    | 'capture'
    | 'house_created'
    | 'house_cemented'
    | 'sweep'
    | 'round_end'
    | 'game_end'
  playerId: string
  payload: any
  timestamp: number
}

export type CardPile = Card[]
export type PlayerId = string
export type TeamId = string
export type HouseId = string
