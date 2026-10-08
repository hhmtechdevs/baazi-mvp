/**
 * Who deals, and therefore who calls.
 *
 * The engine's rule is that the seat AFTER the dealer calls (dealOpeningHands sets bidderId to
 * nextPlayerId of the dealer), so "I want to be the caller" is answered by picking the dealer to
 * my right rather than by touching anything about bidding.
 *
 * Nothing frozen is being overridden here. Which seat deals the FIRST round of a game has never
 * been a rule — it has simply been picked at random — and from the second round on the engine's
 * own determineNextDealerSide takes over untouched, so a match still hands the call to whoever
 * the scores say it belongs to.
 */

/** The seat whose turn follows `playerId` — the one who would call if they dealt. */
export function dealerSoThatTheyCall(playerIds: string[], callerId: string): string | null {
  const index = playerIds.indexOf(callerId);
  if (index < 0 || playerIds.length === 0) return null;
  return playerIds[(index - 1 + playerIds.length) % playerIds.length];
}

/**
 * The dealer for a new game: the seat that puts `callerId` on the call when asked, and otherwise
 * whoever `pick` lands on — random in play, so a practice game does not always open the same way.
 */
export function chooseDealer(
  playerIds: string[],
  callerId: string | null,
  pick: () => number = Math.random
): string {
  if (callerId) {
    const dealer = dealerSoThatTheyCall(playerIds, callerId);
    if (dealer) return dealer;
  }
  return playerIds[Math.floor(pick() * playerIds.length)] ?? playerIds[0];
}
