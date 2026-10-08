// ---------------------------------------------------------------------------
// How well Baazigar plays.
//
// Not a second bot. There is exactly one strategy module, one evaluation function and one source
// of legality (Ingredient 4, through the orchestrator); difficulty only turns dials on the
// decision policy that already exists:
//
//   - how far ahead it looks       (the bounded 2-ply refinement in strategy.ts)
//   - how much it actually knows   (whether evaluate consults the card-counted unseen pool)
//   - how fussy it is about weights(the cumulative-score nudge and latent hand value)
//   - how insistent it is on best  (`slack`: it will settle for any move this close to the best)
//
// Every mode plays strictly legal moves, because every mode picks from the same discovered option
// list and cannot see anything the list does not offer. A weaker Baazigar misjudges; it does not
// cheat, and it never plays something the rules forbid.
//
// 'hard' is the bot exactly as it has always been — same constants, same weights, no randomness —
// so it is the default everywhere, and shared tables keep the opponent they have always had.
// ---------------------------------------------------------------------------

export type Difficulty = 'easy' | 'medium' | 'hard';

export const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

/** What the evaluation function is allowed to take into account. */
export interface EvaluationPolicy {
  /**
   * True: judge the danger of a floor value from the card-counted unseen pool. False: assume a
   * flat, uninformed chance the opponent can answer it — which is what not counting cards
   * actually feels like from the other side of the blanket.
   */
  countsCards: boolean;
  /** Flat risk used when `countsCards` is false. */
  blindRisk: number;
  /** Weight on the running game total. 0 = plays each round on its own merits only. */
  cumulativeWeight: number;
  /** Weight on card points still sitting in its own hand. 0 = does not plan around its hand. */
  handPotentialWeight: number;
}

export interface DifficultyPolicy {
  /** How many of the best 1-ply candidates get the 2-ply opponent-reply refinement. 0 = none. */
  lookaheadCandidates: number;
  /** How many opponent replies that refinement weighs. */
  opponentReplies: number;
  /**
   * How much worse than the best a move may be and still get picked. Above 0 the choice among
   * the near-best candidates is random, which is what makes a weaker opponent feel like a person
   * rather than a slightly different machine.
   */
  slack: number;
  evaluation: EvaluationPolicy;
}

const FULL_EVALUATION: EvaluationPolicy = {
  countsCards: true,
  blindRisk: 0.5,
  cumulativeWeight: 0.1,
  handPotentialWeight: 0.5
};

export const DIFFICULTY_POLICIES: Record<Difficulty, DifficultyPolicy> = {
  // Understands Seep. Takes what is in front of it, builds when building is offered, and does not
  // think about your hand, the deck, or the next exchange.
  easy: {
    lookaheadCandidates: 0,
    opponentReplies: 0,
    slack: 12,
    evaluation: { countsCards: false, blindRisk: 0.5, cumulativeWeight: 0, handPotentialWeight: 0 }
  },
  // A real game: it knows what is still out there and looks one exchange ahead, over a narrower
  // field than Hard, and will occasionally take the second-best line.
  medium: {
    lookaheadCandidates: 3,
    opponentReplies: 6,
    slack: 3,
    evaluation: FULL_EVALUATION
  },
  // Unchanged. The constants here are the ones strategy.ts has always used.
  hard: {
    lookaheadCandidates: 5,
    opponentReplies: 12,
    slack: 0,
    evaluation: FULL_EVALUATION
  }
};

export const DEFAULT_DIFFICULTY: Difficulty = 'hard';

export function policyFor(difficulty: Difficulty = DEFAULT_DIFFICULTY): DifficultyPolicy {
  return DIFFICULTY_POLICIES[difficulty] ?? DIFFICULTY_POLICIES[DEFAULT_DIFFICULTY];
}

export const FULL_STRENGTH_EVALUATION = FULL_EVALUATION;

/** Player-facing wording for the three modes. */
export const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

export const DIFFICULTY_BLURB: Record<Difficulty, string> = {
  easy: 'Plays what it sees.',
  medium: 'Plays a real game.',
  hard: 'Counts the cards.'
};
