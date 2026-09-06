/**
 * Among Us, with the settings a host actually tweaks.
 *
 * This used to carry five "variants" — Among Us, One Night Werewolf, Secret
 * Hitler, Avalon, Blood on the Clocktower. That was dropped deliberately.
 * Measured, only three of the five were mechanically distinct: Werewolf,
 * Secret Hitler and Avalon were byte-identical configurations (5-10 players,
 * 2 hidden) differing only in vocabulary. Worse, Avalon and Secret Hitler have
 * no night kill at all — Avalon is quests, Secret Hitler is policy cards — so
 * modelling them as "hidden team kills someone at night" misrepresented the
 * games they were named after.
 *
 * Claiming one game you actually implement beats claiming five where two are
 * wrong. The generalisation the RFP asks about is still real and still in the
 * contract: `SignalRound` takes `min_players`, `max_players` and
 * `hidden_count`, so another hidden-role game is a different constructor call,
 * not a fork. It is simply not dressed up as five menu entries.
 */

export type Settings = {
  /** Seats the lobby will accept. Among Us runs 4-15; the contract caps at 15. */
  maxPlayers: number;
  /** How many impostors. The contract requires 2 * impostors < minPlayers. */
  impostors: number;
  /** Tasks dealt to each player. */
  tasksPerPlayer: number;
  /** Seconds of free roam before a meeting can be forced. */
  nightSecs: number;
  /** Seconds the ballot stays open. */
  voteSecs: number;
  /**
   * Among Us's "Confirm Ejects". When off, the ejection scene does not say
   * whether the ejected player was an impostor — a real and much harder way to
   * play, because the crew never get a free confirmation.
   */
  confirmEjects: boolean;
};

export const IMPOSTOR_NAME = "Impostor";
export const IMPOSTOR_PLURAL = "Impostors";
export const CREW_NAME = "Crew";

export const MIN_IMPOSTORS = 1;
export const MAX_IMPOSTORS = 3;
export const MIN_TASKS = 1;
export const MAX_TASKS = 5;
/** `SignalRound::CEIL_PLAYERS`. */
export const PLAYER_CEILING = 15;

export const DEFAULT_SETTINGS: Settings = {
  maxPlayers: 10,
  impostors: 1,
  tasksPerPlayer: 3,
  nightSecs: 90,
  voteSecs: 120,
  confirmEjects: true,
};

/**
 * Seats needed before roles can be assigned.
 *
 * Derived rather than configured: the contract asserts
 * `2 * hidden_count < min_players`, so the impostors must be a strict
 * minority. Exposing both numbers would just let a host build a lobby that
 * the constructor rejects.
 */
export function minPlayersFor(impostors: number): number {
  return Math.max(5, impostors * 2 + 1);
}

/** The right noun for a count, so nothing renders "2 impostor". */
export function impostorLabel(count: number): string {
  return count === 1 ? IMPOSTOR_NAME : IMPOSTOR_PLURAL;
}

/** Clamp a settings object into something the contract will accept. */
export function normalise(s: Settings): Settings {
  const impostors = clamp(s.impostors, MIN_IMPOSTORS, MAX_IMPOSTORS);
  const floor = minPlayersFor(impostors);
  return {
    impostors,
    maxPlayers: clamp(s.maxPlayers, floor, PLAYER_CEILING),
    tasksPerPlayer: clamp(s.tasksPerPlayer, MIN_TASKS, MAX_TASKS),
    nightSecs: clamp(s.nightSecs, 10, 1200),
    voteSecs: clamp(s.voteSecs, 10, 1200),
    confirmEjects: s.confirmEjects,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)));
}
