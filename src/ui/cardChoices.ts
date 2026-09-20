import { labelLegalOptions } from './describeOption';
import type { LegalOption } from '../engine/legalMoves';
import type { GameState } from '../types';

/**
 * Turning the engine's legal options for one card into what a person is asked to decide.
 *
 * Engine = referee. UI = translator. Player = decision maker.
 *
 * Nothing in here knows a single rule of Seep. It never asks what a card's rank is, what is on the
 * floor, or whether something "should" be allowed. It receives the options the engine has already
 * decided are legal, and only does three things with them: names each one in plain words, puts
 * them in a steady order, and says whether the player needs to be asked at all. If the engine
 * offers one option, that is the move; if it offers several, the player chooses.
 *
 * It also never invents or merges choices. Distinctness — that "2 + A" and "A + 2" are one choice,
 * not two — is guaranteed by the engine and pinned by engine tests, so this layer never has to
 * second-guess it.
 */

/** What a player can do with a card, in their words rather than the rulebook's. */
export type ActionVerb = 'COLLECT' | 'CEMENT' | 'ADD TO HOUSE' | 'BUILD HOUSE' | 'PLAY CARD';

/**
 * Which of them an engine option is.
 *
 * CEMENT makes an ordinary house pukka and needs your side to hold the matching card. ADD TO HOUSE
 * drops cards onto a house that is ALREADY pukka, which needs no matching card at all — a
 * difference players act on, so the two cannot share a word. BUILD HOUSE makes a new house, or
 * raises one to a value nothing occupies yet.
 *
 * Both corrections came out of live games on 2026-09-19. First, every house move read BUILD HOUSE,
 * so cementing a King onto an existing 13-house sat beside its collect as "COLLECT [13]" and
 * "BUILD HOUSE K♣ = [13]" — two buttons told apart by a pair of brackets, the second reading
 * exactly like the lone-King house the rules no longer allow. Then CEMENT covered Add-to-Fixed
 * too, and a player was offered what looked like cementing a 9-house while holding no 9: correct
 * under the rules, unreadable on the table.
 *
 * Break and MergeFix stay BUILD HOUSE: they genuinely produce a house at a value that was not
 * there before. The precise internal terms remain the engine's; the detail line still names the
 * house involved.
 */
export function verbFor(option: LegalOption): ActionVerb {
  switch (option.kind) {
    case 'capture':
      // COLLECT, not CAPTURE (Product Owner, 2026-09-19): it is the word used at the table, and
      // what you are doing is picking the cards up. The engine's own term stays 'capture'.
      return 'COLLECT';
    case 'throw':
      return 'PLAY CARD';
    case 'cement':
      return 'CEMENT';
    case 'addToFixed':
      return 'ADD TO HOUSE';
    case 'build':
    case 'break':
    case 'mergeFix':
      return 'BUILD HOUSE';
  }
}

/** The order choices are listed in, so the same situation always looks the same. */
const VERB_ORDER: ActionVerb[] = ['COLLECT', 'CEMENT', 'ADD TO HOUSE', 'BUILD HOUSE', 'PLAY CARD'];

export interface Choice {
  option: LegalOption;
  verb: ActionVerb;
  /** What exactly happens — "7 + 4", "(5 + 6) = 11", "[11] · Seep". Empty for PLAY CARD, whose verb
   * already says everything there is to say. */
  detail: string;
}

/**
 * Every legal option for one card, named and ordered.
 *
 * Labels are resolved across the whole set at once (labelLegalOptions), so suits are added back
 * only where two choices would otherwise read the same — e.g. two different 2s on the floor.
 */
export function choicesForCard(options: LegalOption[], state: GameState): Choice[] {
  const labels = labelLegalOptions(options, state);
  const named = options.map((option, i) => ({
    option,
    verb: verbFor(option),
    detail: detailFrom(option, labels[i])
  }));
  // Stable sort: within one verb, the engine's own order is kept.
  return named
    .map((choice, i) => ({ choice, i }))
    .sort((a, b) => VERB_ORDER.indexOf(a.choice.verb) - VERB_ORDER.indexOf(b.choice.verb) || a.i - b.i)
    .map(({ choice }) => choice);
}

/** The label minus its verb: the verb is shown separately, as the heading of the choice. */
function detailFrom(option: LegalOption, label: string): string {
  if (option.kind === 'throw') return '';
  if (option.kind === 'capture') return label.replace(/^Take\s+/, '');
  return label;
}

/**
 * What tapping a card should do.
 *
 * - no legal option     → the card isn't in play right now; nothing happens
 * - exactly one option  → that IS the move; play it, no confirmation
 * - several options     → the player chooses, from exactly the options the engine offered
 *
 * "One option" means one distinct legal choice — not one kind of action. A card that can capture
 * two different ways has two choices and the player is asked which, even though both are captures.
 */
export type CardPlan =
  | { kind: 'unavailable' }
  | { kind: 'direct'; choice: Choice }
  | { kind: 'choose'; choices: Choice[] };

export function planForCard(options: LegalOption[] | undefined, state: GameState): CardPlan {
  if (!options || options.length === 0) return { kind: 'unavailable' };
  const choices = choicesForCard(options, state);
  if (choices.length === 1) return { kind: 'direct', choice: choices[0] };
  return { kind: 'choose', choices };
}
